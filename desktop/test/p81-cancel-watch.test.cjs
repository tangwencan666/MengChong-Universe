'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const watch = require('./p81-cancel-watch.cjs');

const input = { petId: '00000000-0000-0000-0000-000000000001',
  sessionId: '00000000-0000-0000-0000-000000000002',
  generationId: '00000000-0000-0000-0000-000000000003',
  messageId: '00000000-0000-0000-0000-000000000004', timeoutMs: 1000 };

function harness(options = {}) {
  let controller, callback, text = options.visible === false ? '' : '离线片段';
  let clicks = 0, reads = 0, signal;
  let notifyDelta;
  const deltaChecked = new Promise(resolve => { notifyDelta = resolve; });
  function frame(type, sequence, changes = {}) {
    const data = { version: 1, scope: 'generation', pet_id: input.petId, session_id: input.sessionId,
      generation_id: input.generationId, message_id: input.messageId, sequence,
      occurred_at: 'fixture-time', ...(type === 'delta' ? { text: '离线片段' } : {}),
      ...(['completed', 'cancelled'].includes(type) ? { state: type, content: '离线片段' } : {}), ...changes };
    return 'id: ' + input.generationId + ':' + sequence + '\r\nevent: ' + type
      + '\r\ndata: ' + JSON.stringify(data) + '\r\n\r\n';
  }
  function emit(value) {
    const bytes = new TextEncoder().encode(value);
    if (options.split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
  }
  const button = { disabled: false, click() {
    clicks += 1;
    if (options.onClick) options.onClick({ emit, frame, close: () => controller.close() });
    else { emit(frame('cancelled', 3)); controller.close(); }
  } };
  const context = {
    input: { ...input, timeoutMs: options.timeoutMs ?? input.timeoutMs },
    URL, AbortController, TextDecoder, Date, setTimeout, clearTimeout,
    window: { location: { pathname: '/pets/' + input.petId + '/chat/' + input.sessionId } },
    document: { body: {}, querySelectorAll() { return [{ textContent: text }]; },
      querySelector() { notifyDelta(); return button; } },
    MutationObserver: class { constructor(fn) { callback = fn; } observe() {} disconnect() {} },
    async fetch(route, options) {
      assert.equal(route, '/api/v1/pets/' + input.petId + '/sessions/' + input.sessionId
        + '/generations/' + input.generationId + '/events');
      assert.equal(options.credentials, 'include');
      signal = options.signal;
      reads += 1;
      return new Response(new ReadableStream({ start(value) { controller = value;
        signal.addEventListener('abort', () => { try { controller.error(new Error('aborted')); } catch {} });
      } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  const result = vm.runInNewContext('(' + watch.toString() + ')(input)', context);
  return { result, emit, frame, deltaChecked, close: () => controller.close(),
    render() { text = '离线片段'; callback(); },
    get clicks() { return clicks; }, get reads() { return reads; }, get signal() { return signal; } };
}

test('first scoped SSE delta clicks once without a snapshot polling loop', async () => {
  const h = harness();
  h.emit(': heartbeat\r\n\r\n' + h.frame('start', 1) + h.frame('delta', 2));
  const result = await h.result;
  assert.equal(result.state, 'cancelled'); assert.equal(result.stopClicked, true);
  assert.equal(h.clicks, 1); assert.equal(h.reads, 1); assert.equal(h.signal.aborted, true);
  assert.deepEqual(Array.from(result.events, e => e.type), ['start', 'delta', 'cancelled']);
});

test('DOM mutation triggers cancellation after streamed text becomes visible', async () => {
  const h = harness({ visible: false });
  h.emit(h.frame('start', 1) + h.frame('delta', 2));
  await h.deltaChecked;
  assert.equal(h.clicks, 0);
  h.render();
  assert.equal((await h.result).state, 'cancelled'); assert.equal(h.clicks, 1);
});

test('split UTF-8 bytes and split CRLF boundaries retain one correct delta', async () => {
  const h = harness({ split: true });
  h.emit(h.frame('start', 1) + h.frame('delta', 2));
  const result = await h.result;
  assert.equal(result.content, '离线片段'); assert.equal(result.firstDeltaSequence, 2);
});

test('completion before visible DOM stays a race and cannot become cancellation success', async () => {
  const h = harness({ visible: false });
  h.emit(h.frame('start', 1) + h.frame('delta', 2) + h.frame('completed', 3)); h.close();
  const result = await h.result;
  h.render();
  assert.equal(result.state, 'completed'); assert.equal(result.stopClicked, false); assert.equal(h.clicks, 0);
});

for (const field of ['pet_id', 'session_id', 'generation_id', 'message_id']) {
  test('foreign ' + field + ' fails before clicking any button', async () => {
    const h = harness();
    h.emit(h.frame('start', 1, { [field]: 'foreign-identity' })); h.close();
    await assert.rejects(h.result, /identity mismatch/); assert.equal(h.clicks, 0);
  });
}

for (const lateType of ['delta', 'completed']) {
  test('a post-terminal ' + lateType + ' is rejected', async () => {
    const h = harness({ visible: false });
    h.emit(h.frame('start', 1) + h.frame('delta', 2) + h.frame('completed', 3) + h.frame(lateType, 4));
    h.close(); await assert.rejects(h.result, /after terminal/);
  });
}

test('incomplete stream is not a verified terminal state', async () => {
  const h = harness({ visible: false });
  h.emit(h.frame('start', 1) + h.frame('delta', 2)); h.close();
  await assert.rejects(h.result, /without delta and terminal/);
});

test('deadline aborts the owned read subscription without claiming a terminal state', async () => {
  const h = harness({ visible: false, timeoutMs: 20 });
  h.emit(h.frame('start', 1) + h.frame('delta', 2));
  await assert.rejects(h.result, /interrupted/);
  assert.equal(h.signal.aborted, true); assert.equal(h.clicks, 0);
});
