import test from 'node:test'
import assert from 'node:assert/strict'
import { candidateSelection, decimal, loadMemorySnapshot, MemoryIntentKeys, MemoryProtocolError,
  MemorySnapshotChanged, normalizeMemoryContent, validateMemoryExport, validateMemoryItem,
  validateMemoryPreferences, validateMemoryPreview, validateMemoryReferences } from '../src/features/memory/contracts.ts'

const id = '019f1000-0000-4000-8000-000000000001'
const sid = '019f1000-0000-4000-8000-000000000002'
const mid = '019f1000-0000-4000-8000-000000000003'
const timestamp = '2026-11-01T12:00:00Z'
const later = '2027-01-01T12:00:00Z'
function pref(overrides = {}) {
  return { long_term_memory_enabled: true, version: 1, privacy_epoch: '9007199254740993', context_epoch_floor: '2',
    context_not_before: null, revision: '12', sync_cursor: 'opaque-owner-bound-cursor',
    policy_version: 'memory-policy/1', notice_version: 'memory-notice/1', ...overrides }
}
function item(overrides = {}) {
  return { id, title: '求职方向', content: '优先关注后端岗位。', summary: '优先关注后端岗位。', category: 'career_goal',
    status: 'active', version: 1, created_at: timestamp, updated_at: timestamp, last_confirmed_at: timestamp,
    expires_at: later, revision: '12', sources: [{ kind: 'manual', session_id: null, message_id: null, availability: 'available' }],
    consent_ref: { id: mid, policy_version: 'memory-policy/1', notice_version: 'memory-notice/1', occurred_at: timestamp }, ...overrides }
}
function shown() {
  return { persisted: false, extractor_version: 'local-excerpt/1', expires_at: new Date(Date.now() + 300_000).toISOString(), preview_token: 'opaque-signed-source-receipt',
    candidates: [{ candidate_id: id, title: '求职方向', content: '用户主动选择的消息。', summary: '用户主动选择的消息。', category: 'career_goal',
      suggested_expires_at: later, source_refs: [{ kind: 'chat_message', session_id: sid, message_id: mid, source_message_version: 1, availability: 'available' }] }] }
}
function port(overrides = {}) {
  return {
    preferences: async () => pref(),
    list: async () => ({ items: [item()], next_cursor: null, has_more: false, snapshot_revision: '12' }),
    changes: async () => ({ items: [], next_cursor: 'next-opaque', has_more: false, high_watermark: '12', reset_required: false }), ...overrides,
  }
}
const signal = () => new AbortController().signal

test('epochs retain exact bigint strings and unknown consent schema fails closed', () => {
  assert.equal(validateMemoryPreferences(pref()).privacy_epoch, '9007199254740993')
  for (const bad of [pref({ privacy_epoch: 9007199254740992 }), pref({ context_epoch_floor: '9999999999999999999' }),
    pref({ notice_version: 'unreviewed/2' }), pref({ version: 1.5 }), pref({ sync_cursor: '' })]) {
    assert.throws(() => validateMemoryPreferences(bad), MemoryProtocolError)
  }
  for (const bad of ['00', '-1', '1.1', '9223372036854775808', 1]) assert.throws(() => decimal(bad), MemoryProtocolError)
})

test('legacy management data stays viewable while deleted or malformed active data is rejected', () => {
  assert.equal(validateMemoryItem(item({ status: 'legacy_unconfirmed', category: null, expires_at: null, consent_ref: null })).status, 'legacy_unconfirmed')
  for (const bad of [item({ status: 'deleted' }), item({ status: 'active', consent_ref: null }), item({ sources: [{ kind: 'manual', session_id: sid, message_id: null, availability: 'available' }] })]) {
    assert.throws(() => validateMemoryItem(bad), MemoryProtocolError)
  }
})

test('exports reject deleted content and generation references never require old memory bodies', () => {
  const value = { schema_version: 'p4-memory/1.0-draft', exported_at: timestamp, snapshot_revision: '12', items: [item()] }
  assert.equal(validateMemoryExport(value), value)
  assert.throws(() => validateMemoryExport({ ...value, items: [item({ status: 'deleted' })] }), MemoryProtocolError)
  assert.throws(() => validateMemoryExport({ ...value, session_cookie: 'synthetic-not-an-actual-cookie' }), MemoryProtocolError)
  assert.throws(() => validateMemoryExport({ ...value, items: [item({ password_hash: 'synthetic-not-an-actual-hash' })] }), MemoryProtocolError)
  assert.deepEqual(validateMemoryReferences({ privacy_epoch: '12', items: [{ memory_id: id, memory_version: 1, availability: 'unavailable' }] }).items,
    [{ memory_id: id, memory_version: 1, availability: 'unavailable' }])
})

test('candidate selection is tied to an actual fresh preview and exact original message IDs', () => {
  const value = validateMemoryPreview(shown())
  assert.deepEqual(candidateSelection(value, value.candidates[0]), { sessionId: sid, messageIds: [mid] })
  assert.throws(() => candidateSelection(value, { ...value.candidates[0] }), /预览已失效/)
  assert.throws(() => candidateSelection({ ...value, expires_at: '2020-01-01T00:00:00Z' }, value.candidates[0]), /预览已失效/)
  assert.throws(() => validateMemoryPreview({ ...shown(), persisted: true }), MemoryProtocolError)
  const bad = shown(); bad.candidates[0].source_refs[0].kind = 'manual'
  assert.throws(() => validateMemoryPreview(bad), MemoryProtocolError)
})

test('content checks Unicode codepoints and preserves negation rather than silently truncating', () => {
  const result = normalizeMemoryContent({ title: '  交流偏好\r\n', content: '\r\n不想被催促。🌱\r\n', category: 'communication_preference' })
  assert.equal(result.content, '不想被催促。🌱')
  assert.equal(normalizeMemoryContent({ title: '🌱'.repeat(80), content: '🌱'.repeat(1000), category: 'explicit_note' }).content.length, 2000)
  assert.throws(() => normalizeMemoryContent({ title: '标题', content: 'a'.repeat(1001), category: 'explicit_note' }), /1000/)
  assert.throws(() => normalizeMemoryContent({ title: '标题', content: '内容', category: 'explicit_note', expires_at: '2000-01-01T00:00:00Z' }), /有效期/)
})

test('uncertain writes retain the same key and original payload, and scopes clear them', () => {
  const keys = new MemoryIntentKeys(), payload = { expected_preferences_version: 1, content: '已经确认的内容' }
  const first = keys.obtain('one-explicit-intent', payload)
  payload.content = '后来编辑的值'
  const retry = keys.obtain('one-explicit-intent', { expected_preferences_version: 2 })
  assert.equal(first.key, retry.key)
  assert.deepEqual(retry.payload, { expected_preferences_version: 1, content: '已经确认的内容' })
  keys.complete('one-explicit-intent')
  assert.notEqual(keys.obtain('one-explicit-intent', {}).key, first.key)
  keys.clear()
  assert.equal(keys.peek('one-explicit-intent'), undefined)
  assert.notEqual(keys.obtain('one-explicit-intent', {}).key, first.key)
})

test('snapshot follows server revision and cursor without manufacturing a client cursor', async () => {
  const requested = [], p = port({ list: async (revision, cursor) => {
    requested.push([revision, cursor])
    return cursor ? { items: [item({ id: mid })], next_cursor: null, has_more: false, snapshot_revision: '12' }
      : { items: [item()], next_cursor: 'opaque-page-2', has_more: true, snapshot_revision: '12' }
  }, changes: async (cursor) => {
    assert.equal(cursor, 'opaque-owner-bound-cursor')
    return { items: [], next_cursor: 'next-opaque', has_more: false, high_watermark: '12', reset_required: false }
  } })
  const result = await loadMemorySnapshot(p, signal())
  assert.equal(result.items.length, 2)
  assert.deepEqual(requested, [['12', undefined], ['12', 'opaque-page-2']])
})

test('cross-page duplicates and cyclic cursors cannot fake a complete private snapshot', async () => {
  await assert.rejects(loadMemorySnapshot(port({ list: async () => ({ items: [item()], has_more: true, next_cursor: 'cycle', snapshot_revision: '12' }) }), signal()), MemoryProtocolError)
})

test('changes arriving after page fetch invalidate the full response rather than exposing a stale body', async () => {
  for (const change of [{ high_watermark: '13' }, { reset_required: true }, { has_more: true }, { items: [{ action: 'deleted' }] }]) {
    await assert.rejects(loadMemorySnapshot(port({ changes: async () => ({ items: [], next_cursor: 'opaque', high_watermark: '12', reset_required: false, has_more: false, ...change }) }), signal()), MemorySnapshotChanged)
  }
  await assert.rejects(loadMemorySnapshot(port({ list: async () => ({ items: [item({ revision: '11' })], has_more: false, next_cursor: null, snapshot_revision: '12' }) }), signal()), MemoryProtocolError)
})
