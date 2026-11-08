import { apiBase } from './api'

export async function streamMock(
  message: string, onDelta: (text: string) => void, signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${apiBase}/api/v1/companion/demo/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }), signal,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(data?.error?.message ?? `演示请求失败（HTTP ${response.status}）。`)
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('后端未返回有效的流式响应。')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let verifiedMock = false
  let completed = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = frame.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim()
        const raw = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (!raw) continue
        const data = JSON.parse(raw) as { mode?: string; persisted?: boolean; text?: string }
        if (event === 'error') throw new Error('流式响应中断，请重新体验。')
        if (event === 'meta') {
          verifiedMock = data.mode === 'mock' && data.persisted === false
          if (!verifiedMock) throw new Error('演示模式校验失败，已停止。')
        }
        if (event === 'delta') {
          if (!verifiedMock || typeof data.text !== 'string') throw new Error('无效的演示数据。')
          onDelta(data.text)
        }
        if (event === 'done') completed = verifiedMock && data.mode === 'mock' && data.persisted === false
      }
      if (buffer.length > 65_536) throw new Error('流式数据超出限制。')
      if (done) break
    }
    if (!completed) throw new Error('流式响应提前结束，结果不完整。')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
