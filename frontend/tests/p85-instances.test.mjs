import test from 'node:test'
import assert from 'node:assert/strict'
import { adoption, adoptionIntent, instance, retentionNotice } from '../src/features/p85/instances.ts'
const OWNER='10000000-0000-4000-8000-000000000001',ONE='20000000-0000-4000-8000-000000000001',TWO='20000000-0000-4000-8000-000000000002'
const value=(id=ONE)=>({pet_id:id,pet_instance_id:id,owner_user_id:OWNER,species_id:'hajimi',species_source:'registered_asset',name:'同名',status:'active',version:1,persona_config:{description:'各自独立',tone:'warm'},appearance_config:{asset_id:'hajimi',tint:'#abcdef',scale:1},appearance_id:'hajimi-base-v1',personality_snapshot:{description:'各自独立',tone:'warm'},personality_snapshot_version:1})
test('a successful adoption resets the intent; retry preserves its key and a changed payload replaces it',()=>{
  const payload=adoption('hajimi',' 同名 ');let key=0;const make=()=>String(++key)
  const first=adoptionIntent(null,payload,make)
  assert.equal(adoptionIntent(first,payload,make).key,first.key)
  assert.notEqual(adoptionIntent(null,payload,make).key,first.key)
  assert.notEqual(adoptionIntent(first,adoption('hajimi','新名字'),make).key,first.key)
})
test('same species and same name do not merge instance identities; rename keeps the UUID',()=>{
  assert.notEqual(instance(value(),OWNER).pet_instance_id,instance(value(TWO),OWNER).pet_instance_id)
  assert.equal(instance({...value(),name:'新名字'},OWNER,ONE).pet_instance_id,ONE)
  assert.equal(adoption('hajimi','').name,'哈吉米')
})
test('owner, response instance and registered species must match instead of relying on names',()=>{
  for(const change of [{owner_user_id:TWO},{pet_instance_id:TWO},{species_id:'outside'},{species_source:'name'},{version:0},{appearance_id:'whale-source-v1'},{personality_snapshot_version:2},{personality_snapshot:{description:'别只宠物',tone:'warm'}}])assert.throws(()=>instance({...value(),...change},OWNER,ONE))
  assert.throws(()=>adoption('../../image','名字'))
  assert.throws(()=>adoption('hajimi','x'.repeat(61)))
  assert.throws(()=>adoption('hajimi','x'+String.fromCharCode(1)))
})
test('removal disclosure distinguishes archived identity, retained chat and manageable memory',()=>{
  assert.match(retentionNotice.instance,/不能撤销/)
  assert.match(retentionNotice.chat,/不删除聊天正文/)
  assert.match(retentionNotice.memory,/另行/)
})
