'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { createGateway, backendUrl, uiPath } = require('../src/gateway.cjs');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  assert.ok(port >= 1024);
  return port;
}

async function availablePort() {
  const holder = http.createServer();
  const port = await listen(holder);
  await new Promise((resolve) => holder.close(resolve));
  return port;
}

async function fixture(t, handler, options = {}) {
  const base = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(base, 'weibiye-gateway-'));
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let gateway;
  t.after(async () => {
    if (gateway) await gateway.close();
    const closing = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closing;
    // Remove only this fixture's newly created temp directory, never a computed parent.
    if (path.dirname(directory) !== base || !path.basename(directory).startsWith('weibiye-gateway-')) {
      throw new Error('Unexpected temporary directory boundary');
    }
    await fs.rm(directory, { recursive: true, force: false });
  });
  const uiDir = path.join(directory, 'ui');
  const petDir = path.join(directory, 'pet');
  const assetDir = path.join(directory, 'assets');
  await Promise.all([uiDir, petDir, assetDir].map((value) => fs.mkdir(value)));
  await Promise.all([
    fs.writeFile(path.join(uiDir, 'index.html'), '<!doctype html><main>WeiBiYe local UI fixture</main>'),
    fs.writeFile(path.join(uiDir, 'app.js'), 'void 0;'),
    fs.writeFile(path.join(petDir, 'pet.html'), '<!doctype html><button>Original pet fixture</button>'),
    fs.writeFile(path.join(assetDir, 'cat.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    fs.writeFile(path.join(assetDir, 'manifest.json'), '{"version":1}'),
    fs.writeFile(path.join(uiDir, 'not-served.env'), 'SYNTHETIC_FIXTURE_ONLY=true'),
  ]);
  if (options.previewFrames) {
    const preview = path.join(directory, 'local-preview');
    await fs.mkdir(preview);
    await Promise.all(Object.entries(options.previewFrames).map(([name, bytes]) => fs.writeFile(path.join(preview, name), bytes)));
  }
  if (options.shippedPreview) await fs.writeFile(path.join(assetDir, 'deepseek-open.png'), options.shippedPreview);
  const backendPort = await listen(server);
  const uiPort = await availablePort();
  gateway = await createGateway({ uiPort, backendOrigin: 'http://127.0.0.1:' + backendPort, uiDir, petDir, assetDir,
    rootDir: directory, localCharacter: options.localCharacter, apiEnabled: options.apiEnabled });
  return { port: uiPort, origin: gateway.origin, backendPort, gateway };
}

function request(value, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: value.port,
      path: options.path ?? '/', method: options.method ?? 'GET', headers: options.headers ?? {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(4000, () => req.destroy(new Error('Fixture HTTP request timed out')));
    req.once('error', reject);
    req.end(options.body);
  });
}

const previewConfig = () => ({ kind: 'deepseek', ownerId: '10000000-0000-4000-8000-000000000001',
  petId: '30000000-0000-4000-8000-000000000001', assetId: 'deepseek-local-preview' });
const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const previewFrames = () => ({ 'deepseek-open.png': transparentPng, 'deepseek-blink.png': transparentPng });

test('successive loopback identity reads avoid a closed pooled upstream socket', async t => {
  const seen = new Set(); let received = 0;
  const value = await fixture(t, (req, res) => {
    received++;
    // Deterministically model the peer closing an idle connection as it is reused.
    if (seen.has(req.socket)) { req.socket.destroy(); return; }
    seen.add(req.socket);
    assert.equal(req.headers.cookie, 'session=SYNTHETIC_FIXTURE_ONLY');
    res.setHeader('Content-Type', 'application/json'); res.end('{"active":true}');
  });
  for (let n = 0; n < 2; n++) {
    const response = await request(value, {path:'/api/v1/auth/me',headers:{cookie:'session=SYNTHETIC_FIXTURE_ONLY'}});
    assert.equal(response.status,200);
    assert.deepEqual(JSON.parse(response.body),{active:true});
  }
  assert.equal(received,2); assert.equal(seen.size,2);
});

test('a failed upstream mutation is forwarded once and never automatically retried', async t => {
  let received = 0;
  const value = await fixture(t, req => {received++;req.socket.destroy();});
  const response = await request(value,{path:'/api/v1/synthetic-operation',method:'POST',headers:{origin:value.origin,'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,502);
  assert.equal(JSON.parse(response.body).error.code,'LOCAL_API_UNAVAILABLE');
  assert.equal(received,1);
});

test('default gateway never reads or publishes the local preview even when its frames exist', async (t) => {
  const value = await fixture(t, (_req, res) => res.end('unused'), { previewFrames: previewFrames() });
  for (const file of ['deepseek-open.png', 'deepseek-blink.png']) {
    assert.equal((await request(value, { path: '/__assets/' + file })).status, 404);
    assert.equal((await request(value, { path: '/local-preview/' + file })).status, 404);
  }
  assert.equal((await request(value, { path: '/__assets/cat.svg' })).status, 200);
});

test('opted-in gateway publishes only the two fixed reviewed PNGs with pet CSP', async (t) => {
  const value = await fixture(t, (_req, res) => res.end('unused'), {
    localCharacter: previewConfig(), previewFrames: previewFrames(),
  });
  for (const file of ['deepseek-open.png', 'deepseek-blink.png']) {
    const response = await request(value, { path: '/__assets/' + file });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.match(response.headers['content-security-policy'], /connect-src 'none'/);
  }
  for (const file of ['source-reference.png', 'frames.json', 'deepseek.svg']) {
    assert.equal((await request(value, { path: '/__assets/' + file })).status, 404);
  }
  assert.equal((await request(value, { path: '/local-preview/deepseek-open.png' })).status, 404);
});

test('preview startup refuses missing, partial, extra or invalid configuration instead of falling back', async (t) => {
  await assert.rejects(fixture(t, (_req, res) => res.end('unused'), { localCharacter: previewConfig() }));
  await assert.rejects(fixture(t, (_req, res) => res.end('unused'), {
    localCharacter: previewConfig(), previewFrames: { 'deepseek-open.png': transparentPng },
  }));
  await assert.rejects(fixture(t, (_req, res) => res.end('unused'), {
    localCharacter: previewConfig(), previewFrames: { ...previewFrames(), 'unreviewed.png': transparentPng },
  }));
  await assert.rejects(fixture(t, (_req, res) => res.end('unused'), {
    localCharacter: { ...previewConfig(), kind: 'unknown' }, previewFrames: previewFrames(),
  }));
});

test('unlicensed preview frames cannot be put in the ordinary shipped asset directory', async (t) => {
  await assert.rejects(fixture(t, (_req, res) => res.end('unused'), { shippedPreview: transparentPng }));
  await assert.rejects(fixture(t, (_req, res) => res.end('unused'), {
    shippedPreview: transparentPng, localCharacter: previewConfig(), previewFrames: previewFrames(),
  }));
});

test('gateway permits only explicit loopback API origins and scoped UI routes', () => {
  assert.equal(backendUrl('http://127.0.0.1:38316').origin, 'http://127.0.0.1:38316');
  for (const value of [
    'https://127.0.0.1:38316', 'http://localhost:38316', 'http://192.168.1.8:38316',
    'http://example.com:38316', 'http://127.0.0.1', 'http://127.0.0.1:80',
    'http://name:password@127.0.0.1:38316', 'http://127.0.0.1:38316/api',
    'http://127.0.0.1:38316/?query=1', 'http://127.0.0.1:38316/#hash',
  ]) assert.throws(() => backendUrl(value));
  const pet = '12345678-1234-1234-1234-123456789abc';
  assert.equal(uiPath('/pets/' + pet + '/memory'), true);
  assert.equal(uiPath('/pets/' + pet + '/chat/' + pet), true);
  assert.equal(uiPath('/community'), false);
  assert.equal(uiPath('/applications'), false);
  assert.equal(uiPath('/arbitrary/../private'), false);
});

test('gateway rejects foreign Host/Origin and writes lacking a matching browser Origin', async (t) => {
  let forwarded = 0;
  const value = await fixture(t, (_req, res) => { forwarded += 1; res.end('ok'); });
  const invalid = [
    { path: '/api/v1/auth/me', headers: { host: 'localhost:' + value.port } },
    { path: '/api/v1/auth/me', headers: { host: 'evil.example:' + value.port } },
    { path: '/api/v1/auth/me', headers: { origin: 'https://evil.example' } },
    { path: '/api/v1/chat/sessions', method: 'POST' },
    { path: '/api/v1/chat/sessions', method: 'POST', headers: { origin: 'null' } },
    { path: '/api/v1/chat/sessions', method: 'DELETE', headers: { origin: 'http://127.0.0.1:' + (value.port + 1) } },
  ];
  for (const options of invalid) {
    const response = await request(value, options);
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error.code, 'ORIGIN_REJECTED');
  }
  assert.equal(forwarded, 0);
  assert.equal((await request(value, { path: '/api/v1/chat/sessions', method: 'POST', headers: { origin: value.origin } })).status, 200);
  assert.equal(forwarded, 1);
});

test('gateway preserves Cookie, CSRF, idempotency, Last-Event-ID and backend cookie attributes', async (t) => {
  let received;
  const value = await fixture(t, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': [
        'session=synthetic-session; HttpOnly; SameSite=Lax; Path=/',
        'csrf=synthetic-csrf; SameSite=Lax; Path=/',
      ], 'Cache-Control': 'public, max-age=60' });
      res.end('{"created":true}');
    });
  });
  const body = '{"content":"synthetic unit fixture"}';
  const response = await request(value, { path: '/api/v1/companion/generations?scope=pet', method: 'POST', body,
    headers: { origin: value.origin, cookie: 'session=synthetic-session; csrf=synthetic-csrf',
      'x-csrf-token': 'synthetic-csrf', 'idempotency-key': 'synthetic-idempotency-1',
      'last-event-id': '42', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      authorization: 'Bearer DO_NOT_FORWARD_FIXTURE', 'x-user-id': 'DO_NOT_FORWARD_FIXTURE',
    },
  });
  assert.equal(response.status, 201);
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/api/v1/companion/generations?scope=pet');
  assert.equal(received.body, body);
  assert.equal(received.headers.origin, value.origin);
  assert.equal(received.headers.cookie, 'session=synthetic-session; csrf=synthetic-csrf');
  assert.equal(received.headers['x-csrf-token'], 'synthetic-csrf');
  assert.equal(received.headers['idempotency-key'], 'synthetic-idempotency-1');
  assert.equal(received.headers['last-event-id'], '42');
  assert.equal(received.headers.authorization, undefined);
  assert.equal(received.headers['x-user-id'], undefined);
  assert.deepEqual(response.headers['set-cookie'], [
    'session=synthetic-session; HttpOnly; SameSite=Lax; Path=/', 'csrf=synthetic-csrf; SameSite=Lax; Path=/',
  ]);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('gateway does not synthesize a CSRF token or cookie for an unauthenticated request', async (t) => {
  let headers;
  const value = await fixture(t, (req, res) => { headers = req.headers; res.writeHead(401); res.end('unauthorized fixture'); });
  const response = await request(value, { path: '/api/v1/chat/sessions', method: 'POST', headers: { origin: value.origin } });
  assert.equal(response.status, 401);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers['x-csrf-token'], undefined);
});

test('gateway forwards delayed SSE chunks until completion without buffering or premature close', async (t) => {
  const first = 'id: 1\nevent: start\ndata: {"status":"running"}\n\n';
  const delta = 'id: 2\nevent: delta\ndata: {"text":"Mock fixture"}\n\n';
  const last = 'id: 3\nevent: completed\ndata: {"status":"completed"}\n\n';
  let upstreamEndedAt = 0;
  let observedEventId;
  const value = await fixture(t, (req, res) => {
    observedEventId = req.headers['last-event-id'];
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    res.write(first);
    const timers = [
      setTimeout(() => res.write(delta), 80),
      setTimeout(() => { upstreamEndedAt = Date.now(); res.end(last); }, 180),
    ];
    res.on('close', () => timers.forEach(clearTimeout));
  });
  const result = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: value.port,
      path: '/api/v1/companion/generations/synthetic/events', headers: { 'last-event-id': '0' },
    }, (res) => {
      const chunks = [];
      let firstChunkAt;
      res.on('data', (chunk) => { firstChunkAt ??= Date.now(); chunks.push(chunk); });
      res.once('error', reject);
      res.once('end', () => resolve({ chunks, firstChunkAt, completedAt: Date.now(), headers: res.headers }));
    });
    req.setTimeout(4000, () => req.destroy(new Error('SSE fixture timed out')));
    req.once('error', reject);
  });
  assert.equal(observedEventId, '0');
  assert.equal(result.headers['content-type'], 'text/event-stream');
  assert.equal(Buffer.concat(result.chunks).toString(), first + delta + last);
  assert.ok(result.chunks.length >= 3, 'SSE frames should arrive in independently delayed chunks');
  assert.ok(result.firstChunkAt < upstreamEndedAt, 'first event must be delivered before upstream completes');
  assert.ok(result.completedAt >= upstreamEndedAt);
});

test('aborting downstream SSE closes the upstream response and releases its socket', async (t) => {
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const value = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: start\ndata: {"fixture":true}\n\n');
    res.once('close', () => resolveClosed({ ended: res.writableEnded, destroyed: res.destroyed }));
  });
  await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: value.port, path: '/api/v1/chat/stream' }, (res) => {
      res.on('error', () => {});
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
    });
    req.setTimeout(4000, () => req.destroy(new Error('Abort fixture timed out')));
    req.once('error', reject);
  });
  let timer;
  const result = await Promise.race([
    closed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream remained open after downstream abort')), 1500); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(result.ended, false);
  assert.equal(result.destroyed, true);
});

test('gateway refuses unsafe paths, methods, oversized bodies and serves only packaged assets', async (t) => {
  let forwarded = 0;
  const value = await fixture(t, (_req, res) => { forwarded += 1; res.end('ok'); });
  for (const unsafe of ['/../secret', '/%2e%2e/secret', '/__assets/%2e%2e/secret', '//outside.example/api',
    'http://outside.example/api', '/%5cwindows', '/a\\b', '/%00secret', '/%broken']) {
    const response = await request(value, { path: unsafe });
    assert.equal(response.status, 400, unsafe);
    assert.equal(JSON.parse(response.body).error.code, 'INVALID_PATH');
  }
  assert.equal((await request(value, { path: '/not-served.env' })).status, 404);
  assert.equal((await request(value, { path: '/__assets/unknown.svg' })).status, 404);
  assert.equal((await request(value, { path: '/api/v1/chat/sessions', method: 'TRACE' })).status, 405);
  const oversized = await request(value, { path: '/api/v1/chat/sessions', method: 'POST',
    headers: { origin: value.origin, 'content-length': '65537' } });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).error.code, 'BODY_TOO_LARGE');
  assert.equal(forwarded, 0);
});

test('static pet resources use a network-disabled CSP while React permits only same-origin API', async (t) => {
  const value = await fixture(t, (_req, res) => res.end('unused'));
  const ui = await request(value, { path: '/companions' });
  const pet = await request(value, { path: '/__pet/pet.html' });
  const asset = await request(value, { path: '/__assets/cat.svg' });
  const inventory = await request(value, { path: '/__assets/manifest.json' });
  assert.equal(ui.status, 200);
  assert.match(ui.body, /WeiBiYe local UI fixture/);
  assert.match(ui.headers['content-security-policy'], /connect-src 'self'/);
  for (const resource of [pet, asset, inventory]) {
    assert.equal(resource.status, 200);
    assert.match(resource.headers['content-security-policy'], /connect-src 'none'/);
    assert.match(resource.headers['content-security-policy'], /default-src 'none'/);
    assert.match(resource.headers['content-security-policy'], /script-src 'self'/);
    assert.match(resource.headers['content-security-policy'], /frame-src 'none'/);
    assert.equal(resource.headers['content-security-policy'].includes('unsafe-inline'), false);
    assert.equal(resource.headers['cache-control'], 'no-store');
    assert.equal(resource.headers['x-frame-options'], 'DENY');
    assert.equal(resource.headers['x-content-type-options'], 'nosniff');
    assert.equal(resource.headers['referrer-policy'], 'no-referrer');
  }
  assert.equal(asset.headers['content-type'], 'image/svg+xml');
  const head = await request(value, { path: '/__pet/pet.html', method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('gateway rejects external redirects and rewrites only a loopback backend redirect', async (t) => {
  let backendPort;
  const value = await fixture(t, (req, res) => {
    const location = req.url.includes('external') ? 'https://outside.example/collect' : 'http://127.0.0.1:' + backendPort + '/api/v1/auth/me?fixture=1';
    res.writeHead(302, { Location: location });
    res.end();
  });
  backendPort = value.backendPort;
  const external = await request(value, { path: '/api/v1/external' });
  assert.equal(external.status, 502);
  assert.equal(JSON.parse(external.body).error.code, 'REDIRECT_REJECTED');
  const local = await request(value, { path: '/api/v1/local' });
  assert.equal(local.status, 302);
  assert.equal(local.headers.location, value.origin + '/api/v1/auth/me?fixture=1');
});

test('hosted mode disables loopback API forwarding while retaining only local resources', async t => {
  const value = await fixture(t, () => assert.fail('Hosted UI must never forward API credentials to a local backend'), {apiEnabled:false});
  assert.equal((await request(value, {path:'/api/v1/auth/me'})).status, 404);
  assert.equal((await request(value, {path:'/health/ready'})).status, 404);
  assert.equal((await request(value, {path:'/__pet/pet.html'})).status, 200);
});
