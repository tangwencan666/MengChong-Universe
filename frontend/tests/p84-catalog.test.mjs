import test from 'node:test'
import assert from 'node:assert/strict'
import { petDefinitions, petConfiguration } from '../src/features/p84/catalog.ts'

test('eight templates preserve the original five and produce separate safe configuration copies', () => {
  assert.deepEqual(petDefinitions.map(value => value.name), ['月芽', '豆包', '小云', '耄耋', '哈吉米', '奶娃', '刀盾', '鲸鱼娘'])
  const values = petDefinitions.map(value => petConfiguration(value.id))
  assert.equal(new Set(values.map(value => value.persona_config.description)).size, 8)
  assert.equal(new Set(values.map(value => value.appearance_config.asset_id)).size, 8)
  assert.equal(values[3].persona_config.tone, 'playful')
  assert.equal(values[4].persona_config.tone, 'warm')
  for (const value of values) assert.deepEqual(Object.keys(value).sort(), ['appearance_config', 'name', 'persona_config', 'role_type'])
})
test('template selection refuses arbitrary paths and returns fresh objects', () => {
  for (const value of ['../../outside', 'https://outside', 'unknown']) assert.throws(() => petConfiguration(value))
  const value = petConfiguration('maodie')
  value.persona_config.description = 'changed local copy'
  assert.notEqual(petConfiguration('maodie').persona_config.description, value.persona_config.description)
})
