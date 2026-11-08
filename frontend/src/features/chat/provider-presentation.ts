/** Public server mode disclosure. Never infer the next provider from old messages. */
export interface ChatRuntime {
  schema_version: 'chat-runtime/1'
  provider: string
  model: string | null
  mode: 'mock' | 'real'
  billing: 'none' | 'external_provider'
  memory_injection_enabled: boolean
}

export function validateChatRuntime(value: unknown): ChatRuntime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('聊天模型配置尚未确认。')
  const data = value as Record<string, unknown>
  const keys = ['schema_version', 'provider', 'model', 'mode', 'billing', 'memory_injection_enabled']
  if (Object.keys(data).length !== keys.length || keys.some((key) => !(key in data))
    || data.schema_version !== 'chat-runtime/1'
    || typeof data.provider !== 'string' || !data.provider || data.provider.length > 100
    || !(data.model === null || typeof data.model === 'string' && data.model.length > 0 && data.model.length <= 200)
    || typeof data.memory_injection_enabled !== 'boolean'
    || (data.provider === 'mock'
      ? data.mode !== 'mock' || data.billing !== 'none' || data.model !== null
      : data.mode !== 'real' || data.billing !== 'external_provider' || data.model === null || data.memory_injection_enabled)) {
    throw new Error('聊天服务返回的模型配置无法确认，暂不发送新消息。')
  }
  return data as unknown as ChatRuntime
}

export function replyProviderLabel(provider: string | null | undefined, demo: boolean): string {
  if (demo || provider === 'mock') return 'Mock'
  if (provider === 'deepseek') return 'DeepSeek'
  if (provider === 'openai') return 'OpenAI'
  return 'AI'
}

export function sameRuntime(left: ChatRuntime, right: ChatRuntime): boolean {
  return left.provider === right.provider && left.model === right.model && left.mode === right.mode
    && left.billing === right.billing && left.memory_injection_enabled === right.memory_injection_enabled
}

export function composerDisclosure(runtime: ChatRuntime | null, pet: boolean): string {
  const scope = pet ? '聊天仅属于当前账户的这只宠物' : '消息保存于当前账户'
  if (!runtime) return `模型配置尚未确认 · ${scope} · 暂不发送新消息`
  if (runtime.mode === 'mock') return `本地 Mock · 未调用真实模型 · ${scope} · 不计费`
  return `${replyProviderLabel(runtime.provider, false)} · ${runtime.model} · 本次消息及当前会话历史将发往模型服务商，可能产生 API 费用 · ${scope} · 本次不额外注入长期记忆`
}
