import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NIWA_LAUGH_FRAMES } from './niwa-animation.mjs';
import { LocalArena } from './online-service.mjs';
import { handleOnline } from './online-http.mjs';

const root = new URL('./', import.meta.url);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/game.mjs', ['game.mjs', 'text/javascript; charset=utf-8']],
  ['/engine.mjs', ['engine.mjs', 'text/javascript; charset=utf-8']],
  ['/sound.mjs', ['sound.mjs', 'text/javascript; charset=utf-8']],
  ['/niwa-animation.mjs', ['niwa-animation.mjs', 'text/javascript; charset=utf-8']],
  ['/online-client.mjs', ['online-client.mjs', 'text/javascript; charset=utf-8']],
  ['/assets/whale-skill.wav', ['assets/whale-skill.wav', 'audio/wav']],
  ['/assets/daodun-skill.wav', ['assets/daodun-skill.wav', 'audio/wav']],
  ['/assets/niwa-skill.wav', ['assets/niwa-skill.wav', 'audio/wav']],
  ...NIWA_LAUGH_FRAMES.map(file => [file.slice(1), [file.slice(2), 'image/png']]),
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ...['niwa', 'daodun', 'whale'].map(id => [`/assets/${id}.png`, [`assets/${id}.png`, 'image/png']]),
]);
export function createGameServer({arenaOptions} = {}) {
  const arena = new LocalArena(arenaOptions);
  const server = createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'none'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    if (req.headers.host !== `127.0.0.1:${serverPort(req)}`) {
      res.writeHead(403, headers); res.end('Forbidden'); return;
    }
    if (await handleOnline(req, res, arena, headers)) return;
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(403, headers); res.end('Forbidden'); return; }
    const route = files.get(req.url);
    if (!route) { res.writeHead(404, headers); res.end('Not found'); return; }
    try {
      const body = await readFile(new URL(route[0], root));
      res.writeHead(200, { ...headers, 'Content-Type': route[1], 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(500, headers); res.end('Local game asset unavailable'); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxConnections = 128;
  const close = server.close.bind(server);
  server.close = callback => { arena.close(); return close(callback); };
  return server;
}
function serverPort(req) { return req.socket.localPort; }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? 43926);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a local port between 1024 and 65535');
  const server = createGameServer();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'This port is occupied. Choose another port; no existing service was stopped.' : 'Local game server could not start.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`萌宠乱斗：http://127.0.0.1:${port}\n本地人机与双客户端联机原型；不连接AI、QQ或数据库，不开放公网。Ctrl+C停止。`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
