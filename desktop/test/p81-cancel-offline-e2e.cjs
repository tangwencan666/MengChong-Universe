'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { _electron } = require('@playwright/test');
const { desktopEnvironment } = require('../src/launch-env.cjs');
const watchCancellation = require('./p81-cancel-watch.cjs');

const desktop = path.resolve(__dirname, '..');
const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length);
assert.ok(output && path.isAbsolute(output), 'Explicit absolute offline output directory required.');
const ids = { petId: '00000000-0000-0000-0000-000000000001',
  sessionId: '00000000-0000-0000-0000-000000000002',
  generationId: '00000000-0000-0000-0000-000000000003',
  messageId: '00000000-0000-0000-0000-000000000004' };
const viewPath = '/pets/' + ids.petId + '/chat/' + ids.sessionId;
const eventPath = '/api/v1/pets/' + ids.petId + '/sessions/' + ids.sessionId
  + '/generations/' + ids.generationId + '/events';

async function scenario(mode) {
  const clients = new Set(), timers = new Set(), journal = [];
  let terminal = null, cancelCalls = 0, firstSent = false;
  function later(operation, milliseconds) {
    const timer = setTimeout(() => { timers.delete(timer); operation(); }, milliseconds);
    timers.add(timer);
  }
  function frame(type) {
    const sequence = journal.length + 1;
    const data = { version: 1, scope: 'generation', pet_id: ids.petId, session_id: ids.sessionId,
      generation_id: ids.generationId, message_id: ids.messageId, sequence,
      occurred_at: new Date().toISOString(), ...(type === 'delta' ? { text: '离线片段' } : {}),
      ...(['completed', 'cancelled'].includes(type) ? { state: type, content: '离线片段' } : {}) };
    const value = 'id: ' + ids.generationId + ':' + sequence + '\nevent: ' + type
      + '\ndata: ' + JSON.stringify(data) + '\n\n';
    journal.push(value);
    for (const client of clients) client.write(value);
    if (type === 'completed' || type === 'cancelled') {
      terminal = type;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const client of clients) client.end();
    }
  }
  const html = '<!doctype html><body><div role="log"><article class="message-assistant">'
    + '<div class="message-body"><p></p></div></article></div>'
    + '<button aria-label="停止生成">停止</button><script>'
    + 'window.fixtureReady=false; const button=document.querySelector("button");'
    + 'button.onclick=()=>fetch(' + JSON.stringify(eventPath.replace(/\/events$/, '/cancel'))
    + ',{method:"POST"});'
    + '(async()=>{const response=await fetch(' + JSON.stringify(eventPath) + ');'
    + 'const reader=response.body.getReader(), decoder=new TextDecoder();let buffer="";window.fixtureReady=true;'
    + 'while(true){const item=await reader.read();if(item.done)break;buffer+=decoder.decode(item.value,{stream:true});'
    + 'let index;while((index=buffer.indexOf("\\n\\n"))>=0){const part=buffer.slice(0,index);buffer=buffer.slice(index+2);'
    + 'const line=part.split("\\n").find(x=>x.startsWith("data: "));if(!line)continue;const data=JSON.parse(line.slice(6));'
    + 'if(data.text){const show=()=>{document.querySelector("p").textContent+=data.text;};'
    + (mode === 'completion-before-dom' ? 'setTimeout(show,50);' : 'show();') + '}'
    + 'if(data.state==="completed"||data.state==="cancelled"){document.querySelector("p").textContent=data.content;'
    + 'button.remove();document.body.dataset.terminal=data.state;}}}})();</script>';
  frame('start');
  const server = http.createServer((request, response) => {
    if (request.url === viewPath) { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); }
    else if (request.method === 'GET' && request.url === eventPath) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.flushHeaders();
      for (const value of journal) response.write(value);
      if (terminal) { response.end(); return; }
      clients.add(response);
      response.on('close', () => clients.delete(response));
      if (clients.size === 2 && !firstSent) {
        firstSent = true;
        later(() => {
          frame('delta');
          if (mode === 'completion-before-dom') frame('completed');
          else later(() => frame('completed'), 413);
        }, 10);
      }
    } else if (request.method === 'POST' && request.url === eventPath.replace(/\/events$/, '/cancel')) {
      cancelCalls += 1;
      response.writeHead(terminal ? 200 : 202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ state: terminal ?? 'cancel_requested' }));
      if (!terminal) later(() => frame('cancelled'), 0);
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let app;
  try {
    app = await _electron.launch({ executablePath: path.join(desktop, 'node_modules/electron/dist/electron.exe'),
      args: [path.join(__dirname, 'fixtures/p81-cancel-window.cjs'),
        '--p81-fixture-url=http://127.0.0.1:' + port + viewPath,
        '--p81-fixture-profile=' + path.join(output, 'profile-' + crypto.randomUUID())],
      env: desktopEnvironment(process.env), timeout: 30000 });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.fixtureReady === true);
    const result = await page.evaluate(watchCancellation, { ...ids, timeoutMs: 10000 });
    const latency = result.stopClickedAt ? Date.parse(result.stopClickedAt) - Date.parse(result.firstDeltaReceivedAt) : null;
    if (mode === 'fast-413ms') {
      assert.equal(result.state, 'cancelled'); assert.equal(result.stopClicked, true);
      assert.equal(cancelCalls, 1); assert.ok(latency >= 0 && latency < 413);
    } else {
      assert.equal(result.state, 'completed'); assert.equal(result.stopClicked, false); assert.equal(cancelCalls, 0);
    }
    assert.equal(result.events.filter(event => ['completed', 'cancelled'].includes(event.type)).length, 1);
    return { mode, state: result.state, stopClicked: result.stopClicked, cancelCalls,
      firstDeltaToClickMs: latency, terminalEventCount: 1, realModelRequests: 0, simulatedModel: true };
  } finally {
    if (app) await app.close();
    for (const timer of timers) clearTimeout(timer);
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const cases = [];
  for (const mode of ['fast-413ms', 'completion-before-dom']) cases.push(await scenario(mode));
  const report = { status: 'P81_SSE_CANCEL_OBSERVER_OFFLINE_VERIFIED', realModelRequests: 0, cases };
  const file = path.join(output, 'electron-cancel-' + crypto.randomUUID() + '.json');
  await fs.writeFile(file, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...report, evidence: file }));
})().catch(() => { console.error('P81 offline observer verification failed. No real model request was made.'); process.exitCode = 1; });
