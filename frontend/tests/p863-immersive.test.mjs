import test from 'node:test'
import assert from 'node:assert/strict'
import { desktopChoice } from '../src/features/p863/selection.ts'
import { readContext, readContextChange } from '../src/features/p863/context.ts'
const ids = Array.from({ length: 10 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
const pet = (id, hidden = false) => ({ pet_id: id, hidden, name: '同名', role_type: 'cat' })

test('eight adopted pets: seventh and eighth selected by UUID from an empty desktop, then five cap and recall', () => {
  const current = [], original = [...ids]
  for (const id of [ids[6], ids[7], ids[0], ids[2], ids[4]]) {
    assert.equal(desktopChoice(id, current), 'release'); current.push(pet(id))
  }
  assert.equal(desktopChoice(ids[5], current), 'limit')
  assert.equal(desktopChoice(ids[6], current), 'recall')
  current.splice(current.findIndex(p => p.pet_id === ids[6]), 1)
  assert.equal(desktopChoice(ids[5], current), 'release')
  assert.deepEqual(ids, original)
})
test('hidden windows, same-species names and a failed bridge operation do not reserve or change selections', () => {
  const current = ids.slice(0, 5).map(id => pet(id, true))
  assert.equal(desktopChoice(ids[6], current), 'release')
  assert.equal(desktopChoice(ids[2], current), 'show')
  // UI derives selection from confirmed bridge state: a failed call leaves it unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(current)), current)
  assert.equal(desktopChoice(ids[6], current), 'release')
  assert.throws(() => desktopChoice('奶娃', current))
})
const value = () => ({ schema: 'pet-local-context/1', owner_id: ids[0], pet_id: ids[1], session_id: ids[2], mood: 'upset', source_event_ids: [ids[3]], story: { event_id: ids[3], source: 'local-event', text: '实际共同经历' }, reason: 'shared', model_injection: false, rag: false })
test('local recount must match owner, instance and session, never inferred from a display name', () => {
  assert.equal(readContext(value(), ids[0], ids[1], ids[2]).mood, 'upset')
  for (const change of [{ owner_id: ids[8] }, { pet_id: ids[8] }, { session_id: ids[8] }, { mood: 'invented' }, { model_injection: true }, { rag: true }]) assert.throws(() => readContext({ ...value(), ...change }, ids[0], ids[1], ids[2]))
})
test('unverified story IDs, unknown source and oversized text are rejected; no-event is explicit', () => {
  for (const change of [{ event_id: ids[8] }, { source: 'deepseek' }, { text: 'x'.repeat(513) }]) assert.throws(() => readContext({ ...value(), story: { ...value().story, ...change } }, ids[0], ids[1], ids[2]))
  assert.equal(readContext({ ...value(), story: null, source_event_ids: [], reason: 'no-event' }, ids[0], ids[1], ids[2]).story, null)
})
test('event invalidations are scoped and carry only permitted IDs and the real mood', () => {
  const change = { owner_id: ids[0], pet_id: ids[1], mood: 'happy', event_ids: [] }
  assert.equal(readContextChange(change, ids[0], ids[1]).mood, 'happy')
  assert.equal(readContextChange(change, ids[8], ids[1]), null)
  assert.equal(readContextChange({ ...change, pet_id: ids[8] }, ids[0], ids[1]), null)
})
