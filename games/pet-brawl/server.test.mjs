import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGameServer } from './server.mjs';
import { NIWA_LAUGH_FRAMES } from './niwa-animation.mjs';

test('static game serves only allowlisted files and does not expose project data', async () => {
  const server = createGameServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const file of ['/', '/engine.mjs', '/game.mjs', '/sound.mjs', '/style.css', '/assets/niwa.png', '/assets/daodun.png', '/assets/whale.png', '/assets/whale-skill.wav', '/assets/daodun-skill.wav']) {
      const response = await fetch(base + file); assert.equal(response.status, 200); assert.ok((await response.arrayBuffer()).byteLength > 100);
      assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    }
    for (const file of ['/niwa-animation.mjs','/assets/niwa-skill.wav',...NIWA_LAUGH_FRAMES.map(file=>file.slice(1))]) { const response=await fetch(base+file);assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>100); }
    for (const file of ['/.env', '/api/v1/pets', '/engine.test.mjs', '/assets/provenance.json', '/%2e%2e/README.md', '/assets/moon.png', '/?file=../../.git']) {
      assert.equal((await fetch(base + file)).status, 404, file);
    }
    assert.equal((await fetch(base, { method: 'POST', body: 'not allowed' })).status, 403);
    assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
    const hostStatus = await new Promise((resolve, reject) => { const request = http.get(base, { headers: { host: 'external.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
    assert.equal(hostStatus, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
