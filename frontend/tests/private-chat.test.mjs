import test from 'node:test'
import assert from 'node:assert/strict'
import { PrivateSseDecoder, GenerationAccumulator, StreamProtocolError, watchGeneration } from '../src/features/chat/private-stream.ts'
import { createSendIntent, currentSessionGeneration, GenerationRetryKeys, normalizeChatText, retryAfterMilliseconds, retryNetworkOnce } from '../src/features/chat/commands.ts'
import { validatePreferences, validateRecentTopic } from '../src/features/chat/topic-validation.ts'
import { assertScope, chatHome, chatLink, memoryLink, petScope } from '../src/features/pets/scope.ts'

const sid = '019f1000-0000-4000-8000-000000000021'
const gid = '019f1000-0000-4000-8000-000000000031'
const mid = '019f1000-0000-4000-8000-000000000042'
const uid = '019f1000-0000-4000-8000-000000000041'
const time = '2026-11-01T04:00:00Z'
const encoder = new TextEncoder()
function snapshot(sequence = 1, content = '', state = 'queued', finishReason = null) {
  const cursor = sequence ? `${gid}:${sequence}` : null
  return { generation: { id: gid, session_id: sid, user_message_id: uid, assistant_message_id: mid,
    retry_of_generation_id: null, state, provider: 'mock', model: null, prompt_version: 'companion-v1',
    created_at: time, started_at: null, finished_at: state === 'completed' ? time : null, last_event_id: cursor, error: null, finish_reason: finishReason },
  assistant_message: { id: mid, session_id: sid, client_message_id: null, sequence: 1, role: 'assistant',
    content, status: state === 'completed' ? 'completed' : 'queued', provider: 'mock', created_at: time,
    completed_at: null, generation_id: gid, finish_reason: finishReason }, resume_after_event_id: cursor }
}
function frame(event, sequence, extra = {}) {
  return { id: `${gid}:${sequence}`, event, data: JSON.stringify({ version: 1, scope: 'generation',
    generation_id: gid, session_id: sid, message_id: mid, sequence, occurred_at: time, ...extra }) }
}
function wire(value, separator = '\n') {
  return `id: ${value.id}${separator}event: ${value.event}${separator}data: ${value.data}${separator}${separator}`
}
const delta = (n, text) => frame('delta', n, { text })
const completed = (n, content, finish_reason = 'stop') => frame('completed', n, { state: 'completed', content, finish_reason, usage: null })
function response(body) { return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }) }
function options(overrides = {}) {
  return { sessionId: sid, generationId: gid, url: `http://127.0.0.1/events`, signal: new AbortController().signal,
    snapshot: async () => snapshot(), onUpdate: () => {}, onState: () => {}, onUnauthorized: () => {},
    sleep: async () => {}, ...overrides }
}

test('pet routes preserve explicit identity and invalid IDs never fall back to legacy', () => {
  assert.equal(chatHome(uid), `/pets/${uid}`)
  assert.equal(chatLink(sid, uid), `/pets/${uid}/chat/${sid}`)
  assert.equal(memoryLink(uid), `/pets/${uid}/memory`)
  assert.equal(petScope(`/pets/${uid}/chat/${sid}`), uid)
  assert.equal(petScope('/memory'), undefined)
  for (const invalid of ['/pets/not-a-uuid', '/pets/%2Fmemory', '/pets/%zz']) assert.throws(() => petScope(invalid))
  assert.throws(() => assertScope({ pet_id: mid }, uid))
  assert.throws(() => assertScope({ pet_id: uid }))
  assert.doesNotThrow(() => assertScope({ pet_id: uid }, uid))
})

test('pet snapshots and all SSE frames bind identity before duplicate handling', () => {
  const seed = snapshot()
  assert.throws(() => new GenerationAccumulator(seed, sid, gid, uid), StreamProtocolError)
  seed.generation.pet_id = uid; seed.assistant_message.pet_id = uid
  assert.throws(() => new GenerationAccumulator(seed, sid, gid), StreamProtocolError)
  const state = new GenerationAccumulator(seed, sid, gid, uid)
  assert.throws(() => state.apply(delta(2, 'missing pet')), StreamProtocolError)
  assert.throws(() => state.apply(frame('delta', 2, { text: 'wrong pet', pet_id: mid })), StreamProtocolError)
  assert.equal(state.apply(frame('delta', 2, { text: 'same pet', pet_id: uid })), 'applied')
  assert.throws(() => state.apply(frame('delta', 2, { text: 'wrong pet duplicate', pet_id: mid })), StreamProtocolError)
  assert.equal(state.apply(frame('delta', 2, { text: 'same pet', pet_id: uid })), 'duplicate')
  state.apply(frame('completed', 3, { pet_id: uid, state: 'completed', content: 'saved', finish_reason: 'stop', usage: null }))
  assert.equal(state.message.content, 'saved')
})

test('UTF-8 Chinese split at every byte, CRLF boundaries, comments and multiline data', () => {
  const received = []; let heartbeats = 0
  const decoder = new PrivateSseDecoder((value) => received.push(value), () => heartbeats++)
  const value = frame('delta', 2, { text: '你好🌱' })
  const json = JSON.stringify(JSON.parse(value.data), null, 2).split('\n').map((line) => `data: ${line}`).join('\r\n')
  const bytes = encoder.encode(`: ping\r\n\r\nid: ${value.id}\r\nevent: delta\r\n${json}\r\n\r\n`)
  for (const byte of bytes) decoder.push(new Uint8Array([byte]))
  assert.equal(heartbeats, 1); assert.equal(received.length, 1)
  assert.equal(JSON.parse(received[0].data).text, '你好🌱')
})
test('bare CR separators work and partial EOF never dispatches a frame', () => {
  const received = []; const decoder = new PrivateSseDecoder((value) => received.push(value))
  decoder.push(encoder.encode(wire(delta(2, '一'), '\r') + 'event: completed\rdata: {'))
  decoder.push(new Uint8Array(), true)
  assert.equal(received.length, 1); assert.equal(received[0].event, 'delta')
})
test('oversized frames are refused before rendering', () => {
  const decoder = new PrivateSseDecoder(() => assert.fail('must not render'))
  assert.throws(() => decoder.push(encoder.encode('data: ' + '中'.repeat(23000))), StreamProtocolError)
})
test('CRLF bytes count toward the exact 64 KiB frame bound', () => {
  const decoder = new PrivateSseDecoder(() => assert.fail('oversized frame must not render'))
  assert.throws(() => decoder.push(encoder.encode('data: ' + 'x'.repeat(65527) + '\r\n\r\n')), StreamProtocolError)
})
test('Retry-After supports seconds and HTTP dates without inventing a cooldown', () => {
  assert.equal(retryAfterMilliseconds('9'), 9000)
  assert.equal(retryAfterMilliseconds('Sun, 01 Nov 2026 04:00:09 GMT', Date.parse('2026-11-01T04:00:00Z')), 9000)
  assert.equal(retryAfterMilliseconds('invalid'), 0)
})
test('event IDs deduplicate, terminal full text replaces incremental content', () => {
  const state = new GenerationAccumulator(snapshot(), sid, gid)
  assert.equal(state.apply(delta(2, '部分')), 'applied')
  assert.equal(state.apply(delta(2, '部分')), 'duplicate')
  state.apply(completed(3, '权威完整内容'))
  assert.equal(state.message.content, '权威完整内容'); assert.equal(state.generation.state, 'completed')
  assert.equal(state.cursor, `${gid}:3`)
})
test('sequence gaps, wrong generation/session and unknown versions are rejected without advancing cursor', () => {
  const state = new GenerationAccumulator(snapshot(), sid, gid)
  assert.throws(() => state.apply(delta(3, '缺块')), StreamProtocolError)
  for (const extra of [{ session_id: crypto.randomUUID() }, { generation_id: crypto.randomUUID() }, { version: 2 }]) {
    assert.throws(() => state.apply(frame('delta', 2, { text: '不应显示', ...extra })), StreamProtocolError)
  }
  assert.equal(state.cursor, `${gid}:1`); assert.equal(state.message.content, '')
})
test('snapshot content and cursor must be coherent and belong to selected task', () => {
  const value = snapshot(); value.resume_after_event_id = `${gid}:2`
  assert.throws(() => new GenerationAccumulator(value, sid, gid), StreamProtocolError)
  assert.throws(() => new GenerationAccumulator(snapshot(), crypto.randomUUID(), gid), StreamProtocolError)
})
test('failed and cancelled terminal events preserve partial saved content', () => {
  const failed = new GenerationAccumulator(snapshot(), sid, gid)
  failed.apply(frame('error', 2, { state: 'failed', content: '已保存部分', error: { code: 'GENERATION_TIMEOUT', message: '暂时中断', retryable: true } }))
  assert.equal(failed.message.status, 'failed'); assert.equal(failed.message.content, '已保存部分')
  const cancelled = new GenerationAccumulator(snapshot(), sid, gid)
  cancelled.apply(frame('cancelled', 2, { state: 'cancelled', content: '已停止部分', reason: 'user_requested' }))
  assert.equal(cancelled.message.status, 'cancelled'); assert.equal(cancelled.message.content, '已停止部分')
})
test('length completion is retained as visible metadata', () => {
  const state = new GenerationAccumulator(snapshot(), sid, gid); state.apply(completed(2, '截断结果', 'length'))
  assert.equal(state.finishReason, 'length')
  assert.equal(state.message.finish_reason, 'length'); assert.equal(state.generation.finish_reason, 'length')
})

test('a terminal snapshot restores length metadata without reopening its SSE stream', async () => {
  let requests = 0; const restored = []
  await watchGeneration(options({ snapshot: async () => snapshot(3, '已保存的截断回复', 'completed', 'length'),
    fetcher: async () => { requests++; assert.fail('terminal snapshot must not reopen SSE') },
    onUpdate: (message, generation, reason) => restored.push({ message, generation, reason }) }))
  assert.equal(requests, 0); assert.equal(restored.at(-1).reason, 'length')
  assert.equal(restored.at(-1).message.content, '已保存的截断回复')
})

test('inconsistent completion metadata is rejected before replacing saved content', () => {
  const value = snapshot(3, '不一致', 'completed', 'length')
  value.assistant_message.finish_reason = 'stop'
  assert.throws(() => new GenerationAccumulator(value, sid, gid), StreamProtocolError)
  assert.throws(() => new GenerationAccumulator(snapshot(1, '', 'queued', 'length'), sid, gid), StreamProtocolError)
})
test('disconnect replays the same GET with Last-Event-ID, never recreates generation', async () => {
  const requests = []; const updates = []; let firstRead = true
  await watchGeneration(options({ fetcher: async (_url, init) => {
    requests.push(init)
    if (requests.length === 1) return response(new ReadableStream({ pull(controller) {
      if (firstRead) { firstRead = false; controller.enqueue(encoder.encode(wire(delta(2, '你好')))) }
      else controller.error(new Error('network interrupted'))
    } }))
    return response(wire(delta(2, '你好')) + wire(completed(3, '你好，完整回复')))
  }, onUpdate: (message) => updates.push(message.content) }))
  assert.equal(requests.length, 2); assert.equal(requests[1].headers['Last-Event-ID'], `${gid}:2`)
  assert.ok(requests.every((request) => request.method === 'GET' && request.credentials === 'include'))
  assert.ok(updates.includes('你好')); assert.equal(updates.at(-1), '你好，完整回复'); assert.ok(!updates.includes('你好你好'))
})
test('a missing event triggers authoritative snapshot replacement and resumes after its cursor', async () => {
  let snapshots = 0; const requests = []; const updates = []
  await watchGeneration(options({ snapshot: async () => ++snapshots === 1 ? snapshot() : snapshot(2, '权威快照', 'running'),
    fetcher: async (_url, init) => { requests.push(init); return response(requests.length === 1 ? wire(delta(3, '不能直接追加')) : wire(completed(3, '最终内容'))) },
    onUpdate: (message) => updates.push(message.content) }))
  assert.equal(snapshots, 2); assert.equal(requests[1].headers['Last-Event-ID'], `${gid}:2`)
  assert.ok(updates.includes('权威快照')); assert.ok(!updates.includes('不能直接追加'))
})

test('server connection STREAM_UNAVAILABLE rereads the snapshot before replaying after its new cursor', async () => {
  let snapshots = 0; const requests = []; const updates = []
  const gap = 'event: error\ndata: {"version":1,"scope":"connection","error":{"code":"STREAM_UNAVAILABLE","message":"重新读取快照","retryable":true}}\n\n'
  await watchGeneration(options({ snapshot: async () => ++snapshots === 1 ? snapshot() : snapshot(4, '日志缺口后的快照', 'running'),
    fetcher: async (_url, init) => { requests.push(init); return response(requests.length === 1 ? gap : wire(completed(5, '最终完整回复'))) },
    onUpdate: (message) => updates.push(message.content) }))
  assert.equal(snapshots, 2); assert.equal(requests.length, 2)
  assert.equal(requests[1].headers['Last-Event-ID'], `${gid}:4`)
  assert.ok(updates.includes('日志缺口后的快照')); assert.equal(updates.at(-1), '最终完整回复')
  assert.ok(requests.every((request) => request.method === 'GET'))
})
test('410 recovers through snapshot, terminal snapshots do not reopen stream', async () => {
  let snapshots = 0; let requests = 0; let content = ''
  await watchGeneration(options({ snapshot: async () => ++snapshots === 1 ? snapshot() : snapshot(3, '已完成快照', 'completed'),
    fetcher: async () => { requests++; return new Response('', { status: 410 }) }, onUpdate: (message) => { content = message.content } }))
  assert.equal(snapshots, 2); assert.equal(requests, 1); assert.equal(content, '已完成快照')
})
test('401 and connection-level auth error stop retry and invalidate identity', async () => {
  for (const connectionError of [false, true]) {
    let unauthorized = 0; let calls = 0
    await assert.rejects(watchGeneration(options({ onUnauthorized: () => unauthorized++, fetcher: async () => {
      calls++
      return connectionError ? response('event: error\ndata: {"version":1,"scope":"connection","error":{"code":"AUTHENTICATION_REQUIRED","message":"请登录","retryable":false}}\n\n') : new Response('', { status: 401 })
    } })))
    assert.equal(unauthorized, 1); assert.equal(calls, 1)
  }
})
test('EOF without terminal is never success, stops after five failures', async () => {
  let calls = 0; const states = []
  await assert.rejects(watchGeneration(options({ fetcher: async () => { calls++; return response('') }, onState: (state) => states.push(state) })))
  assert.equal(calls, 5); assert.equal(states.at(-1), 'disconnected'); assert.ok(!states.includes('completed'))
})
test('429 honors Retry-After before reconnecting', async () => {
  let calls = 0; const delays = []
  await watchGeneration(options({ fetcher: async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '9' } }) : response(wire(completed(2, '恢复'))),
    sleep: async (delay) => { delays.push(delay) } }))
  assert.equal(delays[0], 9000)
})
test('aborting an old session prevents subsequent callbacks and connection attempts', async () => {
  const controller = new AbortController(); const updates = []; let calls = 0
  await watchGeneration(options({ signal: controller.signal, snapshot: async () => { controller.abort(); return snapshot() },
    fetcher: async () => { calls++; return response('') }, onUpdate: (message) => { updates.push(message) } }))
  assert.equal(updates.length, 0); assert.equal(calls, 0)
})
test('a stalled connection times out and remains incomplete', async () => {
  let calls = 0
  await assert.rejects(watchGeneration(options({ timeoutMs: 5, fetcher: async (_url, init) => {
    calls++
    return response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => controller.error(new DOMException('Timed out', 'AbortError')), { once: true })
    } }))
  } })))
  assert.equal(calls, 5)
})
test('message length uses Unicode code points and normalizes CRLF before validation', () => {
  assert.equal(normalizeChatText('  一\r\n二\r三  '), '一\n二\n三')
  assert.equal([...normalizeChatText('😀'.repeat(4000))].length, 4000)
  assert.throws(() => normalizeChatText('😀'.repeat(4001)))
})
test('a network command retries once with the identical intent, manual retry keeps identifiers', async () => {
  const intent = createSendIntent('消息'); const attempts = []; let count = 0
  const action = async () => { attempts.push({ ...intent }); if (++count < 3) throw new Error('network'); return 'accepted' }
  const signal = new AbortController().signal
  await assert.rejects(retryNetworkOnce(action, () => true, signal))
  assert.equal(attempts.length, 2)
  assert.equal(await retryNetworkOnce(action, () => true, signal), 'accepted')
  assert.ok(attempts.every((attempt) => JSON.stringify(attempt) === JSON.stringify(intent)))
})
test('CSRF/validation errors and aborted commands never automatically resubmit', async () => {
  let calls = 0
  await assert.rejects(retryNetworkOnce(async () => { calls++; throw new Error('CSRF') }, () => false, new AbortController().signal))
  assert.equal(calls, 1)
})
test('a newer observed task remains cancellable before its stream snapshot arrives', () => {
  const old = snapshot(3, 'older completed reply', 'completed').generation
  const observed = { ...snapshot().generation, id: crypto.randomUUID() }
  assert.equal(currentSessionGeneration(observed, old, sid).id, observed.id)
  assert.equal(currentSessionGeneration(observed, old, crypto.randomUUID()), null)
  assert.equal(currentSessionGeneration({ ...old, state: 'running' }, old, sid).state, 'completed')
})
test('uncertain generation retries are isolated by session and task and cleared with identity', () => {
  const keys = new GenerationRetryKeys()
  const first = keys.keyFor(sid, gid)
  const secondSession = crypto.randomUUID()
  const secondGeneration = crypto.randomUUID()
  assert.equal(keys.keyFor(sid, gid), first)
  assert.notEqual(keys.keyFor(secondSession, secondGeneration), first)
  assert.equal(keys.keyFor(sid, gid), first)
  keys.confirm(secondSession, secondGeneration)
  assert.equal(keys.keyFor(sid, gid), first)
  keys.clear()
  assert.notEqual(keys.keyFor(sid, gid), first)
})
test('malformed consent values cannot enable recommendations', () => {
  const preferences = { recent_topic_enabled: false, version: 0, consented_at: null }
  assert.equal(validatePreferences(preferences).recent_topic_enabled, false)
  assert.throws(() => validatePreferences({ ...preferences, recent_topic_enabled: 'false' }))
  assert.throws(() => validatePreferences({ ...preferences, version: -1 }))
})
test('recent topics require traceable saved message IDs, source and a valid timestamp', () => {
  const topic = { conversation_id: sid, title: '契约测试', summary: '测试消息摘录', last_message_at: time,
    follow_up_text: '如果你愿意，我们可以从上次的这段话接着聊。', dismissed: false,
    source: 'message-excerpt', source_message_ids: [uid, mid], summary_version: `${sid}:${uid}:${mid}` }
  assert.equal(validateRecentTopic(null), null)
  assert.equal(validateRecentTopic(topic).conversation_id, sid)
  for (const changed of [{ last_message_at: 'invalid' }, { source: 'mock' }, { dismissed: true }, { source_message_ids: [] }]) {
    assert.throws(() => validateRecentTopic({ ...topic, ...changed }))
  }
})
