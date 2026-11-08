import test from 'node:test'
import assert from 'node:assert/strict'
import { desktopActivitySignal } from '../src/features/desktop/activity.ts'

test('desktop bridge sends only scoped generation state, never conversation or memory content', () => {
  const generationId = '10000000-0000-4000-8000-000000000001', sessionId = '10000000-0000-4000-8000-000000000002'
  const message = { generationId, status: 'complete', hasOutput: true,
    content: 'private conversation', memory_refs: ['private-memory'], provider: 'deepseek' }
  assert.deepEqual(desktopActivitySignal(message, sessionId, 4), {
    generation_id: generationId, session_id: sessionId, sequence: 4, state: 'completed', has_output: true,
  })
})

test('invalid identities or presentation revisions cannot cross the desktop bridge', () => {
  const message = { generationId: '10000000-0000-4000-8000-000000000001', status: 'streaming', hasOutput: false }
  for (const revision of [NaN, -1, Infinity, 1000001]) assert.equal(desktopActivitySignal(message, message.generationId, revision), null)
  assert.equal(desktopActivitySignal(message, 'foreign', 1), null)
  assert.equal(desktopActivitySignal({ ...message, generationId: 'foreign' }, message.generationId, 1), null)
})
