import test from 'node:test'
import assert from 'node:assert/strict'
import { navigationActive, petNavigation } from '../src/features/p862/navigation.ts'

test('pet navigation selects one exact view for each social fragment', () => {
  for (const item of petNavigation) {
    const [path, hash] = item.to.split('#')
    const selected = petNavigation.filter(link => navigationActive(link.to, path, hash ? '#' + hash : ''))
    assert.deepEqual(selected.map(link => link.title), [item.title])
  }
})
test('private pet chats, memory and unknown fragments do not acquire a false social selection', () => {
  for (const [pathname, hash] of [['/pets/30000000-0000-4000-8000-000000000007', ''], ['/memory', ''], ['/companions', '#owned-pets']]) {
    assert.equal(petNavigation.some(item => navigationActive(item.to, pathname, hash)), false)
  }
})
