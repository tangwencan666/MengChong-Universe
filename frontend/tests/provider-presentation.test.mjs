import test from 'node:test'
import assert from 'node:assert/strict'
import { composerDisclosure, replyProviderLabel, sameRuntime, validateChatRuntime } from '../src/features/chat/provider-presentation.ts'

const mock = { schema_version: 'chat-runtime/1', provider: 'mock', model: null, mode: 'mock', billing: 'none', memory_injection_enabled: false }
const deepseek = { ...mock, provider: 'deepseek', model: 'deepseek-flash', mode: 'real', billing: 'external_provider' }

test('only confirmed server runtime can claim Mock and no charge', () => {
  assert.equal(validateChatRuntime(mock), mock)
  assert.match(composerDisclosure(mock, true), /本地 Mock.*当前账户的这只宠物.*不计费/)
  assert.match(composerDisclosure(deepseek, false), /DeepSeek.*deepseek-flash.*本次消息及当前会话历史.*API 费用.*本次不额外注入长期记忆/)
  assert.doesNotMatch(composerDisclosure(deepseek, false), /Mock|不计费/)
  assert.match(composerDisclosure(null, false), /模型配置尚未确认.*暂不发送新消息/)
  assert.doesNotMatch(composerDisclosure(null, false), /Mock|不计费/)
})

test('inconsistent mode, fee, schema and real memory injection fail closed', () => {
  for (const invalid of [null, [], {}, { ...mock, mode: 'real' }, { ...mock, billing: 'external_provider' },
    { ...mock, model: 'surprise' }, { ...deepseek, model: null }, { ...deepseek, billing: 'none' },
    { ...deepseek, memory_injection_enabled: true }, { ...deepseek, schema_version: 'chat-runtime/2' },
    { ...deepseek, api_key: 'synthetic-only-forbidden-field' }]) assert.throws(() => validateChatRuntime(invalid))
  assert.equal(validateChatRuntime(deepseek), deepseek)
})

test('historical reply labels use their own provider and unknown is never called Mock', () => {
  assert.equal(replyProviderLabel('mock', false), 'Mock')
  assert.equal(replyProviderLabel('deepseek', false), 'DeepSeek')
  assert.equal(replyProviderLabel('openai', false), 'OpenAI')
  assert.equal(replyProviderLabel(undefined, false), 'AI')
  assert.equal(replyProviderLabel(null, false), 'AI')
  assert.equal(replyProviderLabel('unknown', false), 'AI')
  assert.equal(replyProviderLabel(undefined, true), 'Mock')
  // Seeing an old Mock message does not establish the next request's configuration.
  assert.doesNotMatch(composerDisclosure(null, false), /Mock|不计费/)
})

test('provider, model, fee and memory mode changes require a fresh user action', () => {
  assert.equal(sameRuntime(mock, { ...mock }), true)
  assert.equal(sameRuntime(mock, deepseek), false)
  assert.equal(sameRuntime(deepseek, { ...deepseek, model: 'deepseek-v4-pro' }), false)
  assert.equal(sameRuntime(mock, { ...mock, memory_injection_enabled: true }), false)
})
