import test from 'node:test'
import assert from 'node:assert/strict'
import { makeFeedback } from '../src/features/beta/feedback.ts'

const id = '12345678-1234-4123-8123-123456789012'
const at = '2026-11-02T00:00:00.000Z'

test('feedback exports only a category, random report identifier and canonical date', () => {
  const value = makeFeedback('connection', id, at)
  assert.deepEqual(Object.keys(value).sort(), ['category', 'created_at', 'notice', 'report_id', 'schema'])
  assert.equal(value.category, 'connection')
})

test('free text cannot enter feedback through category or timestamp fields', () => {
  for (const category of ['chat text', 'api_key', { content: 'private' }]) assert.throws(() => makeFeedback(category, id, at))
  assert.throws(() => makeFeedback('connection', id, '2026-11-02 private text'))
  assert.throws(() => makeFeedback('connection', '------------------------------------', at))
})
