import test from 'node:test'
import assert from 'node:assert/strict'
import { appearanceFor, availableViews, appearances } from '../src/features/p85/appearances.ts'
import { adoption, instance } from '../src/features/p85/instances.ts'

test('eight appearance IDs distinguish species and preserve the five existing defaults', () => {
  assert.equal(appearances.length, 8)
  assert.equal(new Set(appearances.map(a => a.appearance_id)).size, 8)
  for (const species of ['moon', 'doubao', 'xiaoyun', 'maodie', 'hajimi']) assert.equal(appearanceFor(species).kind, 'shipped-svg')
  for (const species of ['niwa', 'daodun', 'whale']) {
    assert.equal(adoption(species, '同名').species_id, species)
    assert.equal(appearanceFor(species).restriction, 'local-verification-only')
  }
  assert.throws(() => appearanceFor('whale', 'niwa-source-v1'))
  assert.throws(() => appearanceFor('../../personal-file'))
})

test('view disclosure describes only usable source angles and keeps overlays explicitly unavailable', () => {
  assert.deepEqual(availableViews('niwa'), ['正面', '左侧面', '背面'])
  assert.deepEqual(availableViews('daodun'), ['正面', '左侧面'])
  assert.deepEqual(availableViews('whale'), ['正面'])
  assert.match(appearanceFor('daodun').quality_notes.join(' '), /水印/)
  assert.match(appearanceFor('whale').quality_notes.join(' '), /叠层/)
})

test('instance snapshots must match the persisted configuration and version, not another template or instance', () => {
  const owner='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001'
  const value={owner_user_id:owner,pet_instance_id:id,pet_id:id,species_id:'whale',species_source:'registered_asset',appearance_id:'whale-source-v1',name:'小鲸',status:'active',version:2,persona_config:{description:'只属于此实例',tone:'calm'},appearance_config:{asset_id:'whale-source-v1'},personality_snapshot:{description:'只属于此实例',tone:'calm'},personality_snapshot_version:2}
  assert.equal(instance(value,owner).pet_instance_id,id)
  for(const change of [{appearance_id:undefined},{appearance_id:'niwa-source-v1'},{personality_snapshot_version:1},{personality_snapshot:{description:'另一个实例',tone:'calm'}}])assert.throws(()=>instance({...value,...change},owner))
})
