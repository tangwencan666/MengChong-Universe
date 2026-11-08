'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { registerPetAssets } = require('./pet-asset-cache.cjs');
const { registerAppearanceAssets } = require('./p85-appearance-assets.cjs');
const appearanceManifest = require('../assets/p85-appearances.json');
const petManifest = require('../assets/pet-definitions.json');
const { FILES: LOCAL_CHARACTER_FILES, readLocalCharacterAssets } = require('./local-character.cjs');
const { loadCurrentUi } = require('./ui-assets.cjs');
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.json':'application/json' };
const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const REQUEST = new Set(['accept','accept-language','content-type','content-length','cookie','origin','x-csrf-token','idempotency-key','last-event-id','cache-control']);
function backendUrl(raw) {
  const value = new URL(raw);
  if (value.protocol !== 'http:' || value.hostname !== '127.0.0.1' || !/^\d+$/.test(value.port)
    || +value.port < 1024 || value.username || value.password || value.search || value.hash || value.pathname !== '/') throw new Error('Only an explicit loopback development API origin is supported.');
  return value;
}
async function collect(directory, prefix, files, extensions, lazyPets = false) {
  const base = await fs.realpath(directory);
  async function visit(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes:true })) {
      if (entry.isSymbolicLink()) throw new Error('Static assets cannot contain symbolic links.');
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) { await visit(absolute); continue; }
      const ext = path.extname(entry.name);
      if (!extensions.includes(ext)) continue;
      if (lazyPets && /^p84-.*\.svg$/.test(entry.name)) continue;
      const real = await fs.realpath(absolute);
      if (!real.startsWith(base + path.sep)) throw new Error('Asset outside packaged resources.');
      const bytes = await fs.readFile(real);
      if (bytes.length > 8 * 1024 * 1024) throw new Error('Asset exceeds budget.');
      files.set(prefix + path.relative(base, real).split(path.sep).join('/'), { bytes, type:TYPES[ext] });
    }
  }
  await visit(base);
}
function uiPath(url) {
  return url === '/' || /^\/(?:companions|pet-catalog|memory|wallet|me(?:\/sessions)?|welcome|login|register|forgot-password|resend-verification|verify-email|reset-password|admin|preferences\/conversations)$/.test(url)
    || /^\/chat\/[^/]+$/.test(url) || /^\/pets\/[a-f\d-]{36}(?:\/memory|\/chat\/[a-f\d-]{36})?$/.test(url);
}
async function createGateway({ uiPort = 35316, backendOrigin = 'http://127.0.0.1:38316', uiDir, petDir, assetDir, rootDir, localCharacter, apiEnabled = true }) {
  if (!Number.isInteger(uiPort) || uiPort < 1024 || uiPort > 65535) throw new Error('Invalid UI port.');
  const backend = backendUrl(backendOrigin);
  const origin = 'http://127.0.0.1:' + uiPort;
  const files = new Map();
  if (!(await loadCurrentUi(uiDir, files))) await collect(uiDir, '/', files, ['.html','.js','.css','.svg','.png','.ico']);
  if (!files.has('/index.html')) throw new Error('Build the existing React UI before starting.');
  await collect(petDir, '/__pet/', files, ['.html','.js','.css']);
  // Static data bootstrap retains connect-src 'none' in the pet renderer.
  files.set('/__pet/pet-catalog.js',{type:TYPES['.js'],bytes:Buffer.from(
    'Object.defineProperty(globalThis,"WeiBiYePetCatalog",{value:JSON.parse('+JSON.stringify(JSON.stringify({...petManifest,appearances:appearanceManifest}))+')});\n')});
  const assetRoot=assetDir || path.join(petDir, '../assets');
  await collect(assetRoot, '/__assets/', files, ['.svg','.png','.json','.ico'], true);
  const petAssets=await registerPetAssets(assetRoot,files);
  const localAssets=await registerAppearanceAssets(rootDir||path.resolve(assetRoot,'..'),files);
  for (const name of LOCAL_CHARACTER_FILES) {
    if (files.has('/__assets/' + name)) throw new Error('Unlicensed preview frames cannot override a shipped asset.');
  }
  for (const resource of readLocalCharacterAssets(localCharacter, rootDir)) {
    const pathname = '/__assets/' + resource.name;
    files.set(pathname, { bytes: resource.bytes, type: resource.type });
  }
  const sockets = new Set();
  const error = (res, status, code, message) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
    res.end(JSON.stringify({ error:{ code, message } }));
  };
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== '127.0.0.1:' + uiPort || (req.headers.origin && req.headers.origin !== origin)) return error(res, 403, 'ORIGIN_REJECTED', '本地来源不受信任。');
    let parsed;
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || /\\|%5c|%00/i.test(req.url)) throw new Error();
      parsed = new URL(req.url, origin);
      if (parsed.origin !== origin || /(?:^|\/)\.\.(?:\/|$)/.test(decodeURIComponent(req.url.split('?')[0]))) throw new Error();
    } catch { return error(res, 400, 'INVALID_PATH', '路径无效。'); }
    const api = parsed.pathname.startsWith('/api/v1/') || ['/health/live','/health/ready'].includes(parsed.pathname);
    if (api && !apiEnabled) { res.writeHead(404); res.end(); return; }
    if (api) {
      if (!['GET','HEAD','POST','PATCH','PUT','DELETE','OPTIONS'].includes(req.method)) return error(res, 405, 'METHOD_REJECTED', '请求方式不受支持。');
      if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin !== origin) return error(res, 403, 'ORIGIN_REJECTED', '写操作需要可信来源。');
      if (+req.headers['content-length'] > 65536) return error(res, 413, 'BODY_TOO_LARGE', '请求内容过大。');
      const headers = {};
      for (const [name,value] of Object.entries(req.headers)) if (REQUEST.has(name)) headers[name] = value;
      // Origin, Cookie and CSRF are passed as received, never synthesized or weakened.
      // Fresh loopback sockets avoid the peer's idle-close race. Never retry writes.
      const upstream = http.request({ hostname:backend.hostname, port:backend.port, path:parsed.pathname + parsed.search, method:req.method, headers, agent:false }, (incoming) => {
        if (incoming.headers.location) {
          let location;
          try { location = new URL(incoming.headers.location, backend); } catch { incoming.destroy(); return error(res, 502, 'REDIRECT_REJECTED', '服务重定向无效。'); }
          if (location.origin !== backend.origin) { incoming.destroy(); return error(res, 502, 'REDIRECT_REJECTED', '服务重定向不受信任。'); }
          incoming.headers.location = origin + location.pathname + location.search;
        }
        res.statusCode = incoming.statusCode;
        for (const [name,value] of Object.entries(incoming.headers)) if (!HOP.has(name) && value !== undefined) res.setHeader(name, value);
        res.setHeader('Cache-Control','no-store'); res.flushHeaders();
        incoming.on('error', () => res.destroy());
        incoming.pipe(res);
      });
      let connectTimeout = setTimeout(() => upstream.destroy(), 3000);
      upstream.on('socket', socket => {
        if (!socket.connecting) { clearTimeout(connectTimeout); return; }
        socket.once('connect', () => { clearTimeout(connectTimeout); connectTimeout = undefined; });
      });
      upstream.on('error', () => { clearTimeout(connectTimeout); error(res, 502, 'LOCAL_API_UNAVAILABLE', '本地聊天服务暂不可用。'); });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      let size = 0;
      req.on('data', chunk => { size += chunk.length; if (size > 65536) { upstream.destroy(); error(res, 413, 'BODY_TOO_LARGE','请求内容过大。'); } });
      req.pipe(upstream);
      return;
    }
    if (!['GET','HEAD'].includes(req.method)) return error(res, 405, 'METHOD_REJECTED','请求方式不受支持。');
    const resource = files.get(parsed.pathname) || (uiPath(parsed.pathname) ? files.get('/index.html') : null);
    if (!resource) return error(res, 404, 'NOT_FOUND','找不到本地资源。');
    let bytes;
    try { bytes=resource.read?await resource.read():resource.bytes; }
    catch { return error(res,503,'RESOURCE_UNAVAILABLE','宠物资源暂不可用。'); }
    const pet = parsed.pathname.startsWith('/__pet/') || parsed.pathname.startsWith('/__assets/');
    res.writeHead(200, {
      'Content-Type':resource.type, 'Content-Length':bytes.length, 'Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY', 'Referrer-Policy':'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' " + (pet ? '' : "'unsafe-inline' ") + "; img-src 'self' data:; font-src 'self'; connect-src " + (pet ? "'none'" : "'self'") + "; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  server.requestTimeout = 15000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve,reject) => { server.once('error', reject); server.listen(uiPort, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  return { origin, get assetStats(){return { files:files.size,bytes:[...files.values()].reduce((sum,entry)=>sum+(entry.bytes?.length??0),0),petCache:petAssets.stats,localCache:localAssets.stats };},
    close:() => new Promise(resolve => { petAssets.close();localAssets.close();server.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}
module.exports = { createGateway, backendUrl, uiPath };
