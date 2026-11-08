import type { ChatGeneration, GenerationSnapshot, StoredMessage } from './api-types.ts'
import { isTerminal } from './api-types.ts'

export interface SseFrame { id: string; event: string; data: string }
export class StreamProtocolError extends Error {}
export class StreamHttpError extends Error {
  status: number
  retryAfter: number
  resyncSnapshot: boolean
  constructor(status: number, retryAfter = 0, resyncSnapshot = false) {
    super(`聊天连接暂时不可用（HTTP ${status}）。`)
    this.status = status; this.retryAfter = retryAfter; this.resyncSnapshot = resyncSnapshot
  }
}
/** Incremental UTF-8 decoder; CR, LF and split CRLF are all line terminators. */
export class PrivateSseDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private line = ''
  private pendingCR = false
  private bytes = 0
  private id = ''
  private event = ''
  private data: string[] = []
  private onFrame: (frame: SseFrame) => void
  private onHeartbeat: () => void
  constructor(onFrame: (frame: SseFrame) => void, onHeartbeat = () => {}) {
    this.onFrame = onFrame; this.onHeartbeat = onHeartbeat
  }
  push(chunk: Uint8Array, done = false) {
    const decoded = this.decoder.decode(chunk, { stream: !done })
    if (new TextEncoder().encode(this.line).length > 128 * 1024) throw new StreamProtocolError('流接收缓冲超限。')
    for (const character of decoded) {
      if (this.pendingCR) {
        this.pendingCR = false
        if (character === '\n') {
          if (++this.bytes > 64 * 1024) throw new StreamProtocolError('流事件超出 64 KiB 限制。')
          this.consumeLine(); continue
        }
        this.consumeLine()
      }
      const point = character.codePointAt(0)!
      this.bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
      if (this.bytes > 64 * 1024) throw new StreamProtocolError('流事件超出 64 KiB 限制。')
      if (character === '\r') this.pendingCR = true
      else if (character === '\n') this.consumeLine()
      else this.line += character
    }
    if (done && this.pendingCR) { this.pendingCR = false; this.consumeLine() }
    // An incomplete frame at EOF is deliberately not dispatched as a completed event.
  }
  private consumeLine() {
    const line = this.line; this.line = ''
    if (!line) {
      if (this.data.length) this.onFrame({ id: this.id, event: this.event || 'message', data: this.data.join('\n') })
      this.id = ''; this.event = ''; this.data = []; this.bytes = 0
      return
    }
    if (line.startsWith(':')) { this.onHeartbeat(); return }
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') {
      if (value.includes('\0')) throw new StreamProtocolError('无效事件 ID。')
      this.id = value
    } else if (field === 'event') this.event = value
    else if (field === 'data') this.data.push(value)
  }
}

interface EventData {
  pet_id?: string; version: number; scope: string; generation_id: string; session_id: string; message_id: string
  sequence: number; occurred_at: string; text?: string; content?: string; state?: string
  persisted?: boolean; mode?: string; user_message_id?: string; finish_reason?: string
  error?: { code: string; message: string; retryable: boolean }; reason?: string
  usage?: { input_tokens: number; output_tokens: number } | null
}
function valid(ok: unknown, message = '流协议校验失败，正在重新同步已保存的回复。'): asserts ok {
  if (!ok) throw new StreamProtocolError(message)
}
function eventSequence(id: string | null, generationId: string) {
  if (id === null) return 0
  const prefix = `${generationId}:`
  valid(id.startsWith(prefix) && /^[1-9]\d*$/.test(id.slice(prefix.length)))
  const sequence = Number(id.slice(prefix.length)); valid(Number.isSafeInteger(sequence))
  return sequence
}
export class GenerationAccumulator {
  generation: ChatGeneration
  message: StoredMessage
  cursor: string | null
  sequence: number
  finishReason: string | null = null
  private petId?: string
  constructor(snapshot: GenerationSnapshot, sessionId: string, generationId: string, petId?: string) {
    this.petId = petId
    valid(petId ? snapshot.generation.pet_id === petId && snapshot.assistant_message.pet_id === petId : snapshot.generation.pet_id == null && snapshot.assistant_message.pet_id == null)
    valid(snapshot.generation.id === generationId && snapshot.generation.session_id === sessionId)
    valid(['queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled'].includes(snapshot.generation.state))
    valid(snapshot.assistant_message.id === snapshot.generation.assistant_message_id
      && snapshot.assistant_message.session_id === sessionId && snapshot.assistant_message.role === 'assistant'
      && snapshot.assistant_message.generation_id === generationId && typeof snapshot.assistant_message.content === 'string')
    valid(['queued', 'streaming', 'completed', 'failed', 'cancelled'].includes(snapshot.assistant_message.status))
    this.generation = { ...snapshot.generation }; this.message = { ...snapshot.assistant_message }
    this.cursor = snapshot.resume_after_event_id
    this.sequence = eventSequence(this.cursor, generationId)
    valid(this.cursor === snapshot.generation.last_event_id)
    const generationReason = snapshot.generation.finish_reason ?? null
    const messageReason = snapshot.assistant_message.finish_reason ?? null
    valid([null, 'stop', 'length'].includes(generationReason) && generationReason === messageReason)
    valid(snapshot.generation.state === 'completed' || generationReason === null)
    this.finishReason = generationReason
  }
  apply(frame: SseFrame): 'duplicate' | 'applied' {
    let data: EventData
    try { data = JSON.parse(frame.data) as EventData } catch { throw new StreamProtocolError('无效流数据。') }
    valid(data && data.version === 1)
    if (data.scope === 'connection') {
      valid(frame.event === 'error' && !frame.id && data.error && typeof data.error.code === 'string')
      if (data.error.code === 'AUTHENTICATION_REQUIRED') throw new StreamHttpError(401)
      if (data.error.code === 'STREAM_UNAVAILABLE' && data.error.retryable) throw new StreamHttpError(503, 0, true)
      throw new StreamHttpError(403)
    }
    valid(this.petId ? data.pet_id === this.petId : data.pet_id == null)
    valid(data.scope === 'generation' && data.generation_id === this.generation.id
      && data.session_id === this.generation.session_id && data.message_id === this.message.id
      && Number.isSafeInteger(data.sequence) && data.sequence > 0
      && typeof data.occurred_at === 'string' && Number.isFinite(Date.parse(data.occurred_at))
      && frame.id === `${data.generation_id}:${data.sequence}`)
    valid(['start', 'delta', 'completed', 'error', 'cancelled'].includes(frame.event))
    if (data.sequence <= this.sequence) return 'duplicate'
    valid(data.sequence === this.sequence + 1 && !isTerminal(this.generation.state))
    if (frame.event === 'start') {
      valid(data.sequence === 1 && data.state === 'queued' && data.persisted === true
        && ['mock', 'real'].includes(data.mode ?? '') && data.user_message_id === this.generation.user_message_id)
    } else if (frame.event === 'delta') {
      valid(typeof data.text === 'string' && data.text.length > 0)
      valid([...this.message.content, ...data.text].length <= 8000)
      this.message = { ...this.message, content: this.message.content + data.text, status: 'streaming' }
      this.generation = { ...this.generation, state: 'running' }
    } else {
      valid(typeof data.content === 'string' && [...data.content].length <= 8000)
      if (frame.event === 'completed') {
        valid(data.state === 'completed' && ['stop', 'length'].includes(data.finish_reason ?? '')
          && (data.usage === null || (data.usage && Number.isSafeInteger(data.usage.input_tokens)
            && data.usage.input_tokens >= 0 && Number.isSafeInteger(data.usage.output_tokens) && data.usage.output_tokens >= 0)))
        valid(this.generation.provider !== 'mock' || data.usage === null)
        this.finishReason = data.finish_reason ?? null
        this.generation = { ...this.generation, state: 'completed', error: null, finish_reason: data.finish_reason as 'stop' | 'length' }
        this.message = { ...this.message, status: 'completed', finish_reason: data.finish_reason as 'stop' | 'length' }
      } else if (frame.event === 'error') {
        valid(data.state === 'failed' && data.error && typeof data.error.code === 'string'
          && typeof data.error.message === 'string' && typeof data.error.retryable === 'boolean')
        this.generation = { ...this.generation, state: 'failed', error: data.error }
        this.message = { ...this.message, status: 'failed' }
      } else {
        valid(data.state === 'cancelled' && typeof data.reason === 'string')
        this.generation = { ...this.generation, state: 'cancelled' }
        this.message = { ...this.message, status: 'cancelled' }
      }
      this.message = { ...this.message, content: data.content, completed_at: data.occurred_at }
      this.generation = { ...this.generation, finished_at: data.occurred_at }
    }
    this.sequence = data.sequence; this.cursor = frame.id
    this.generation = { ...this.generation, last_event_id: frame.id }
    return 'applied'
  }
}

interface WatchOptions {
  petId?: string; sessionId: string; generationId: string; url: string; signal: AbortSignal
  snapshot: (signal: AbortSignal) => Promise<GenerationSnapshot>
  onUpdate: (message: StoredMessage, generation: ChatGeneration, finishReason: string | null) => void
  onState: (state: 'connecting' | 'streaming' | 'reconnecting' | 'disconnected' | 'completed') => void
  onUnauthorized: () => void
  fetcher?: typeof fetch
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  timeoutMs?: number
}
export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}
/** Only GET requests occur here; reconnecting can never create a generation. */
export async function watchGeneration(options: WatchOptions): Promise<void> {
  const { signal } = options
  let accumulator: GenerationAccumulator | null = null
  let resync = true
  let failures = 0
  const update = () => options.onUpdate({ ...accumulator!.message }, { ...accumulator!.generation }, accumulator!.finishReason)
  options.onState('connecting')
  while (!signal.aborted) {
    const connection = new AbortController()
    const abort = () => connection.abort()
    signal.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const activity = () => {
      failures = 0
      clearTimeout(timer)
      timer = setTimeout(() => connection.abort(), options.timeoutMs ?? 15_000)
    }
    let retryDelay = 0
    let fatal: unknown = null
    try {
      timer = setTimeout(() => connection.abort(), options.timeoutMs ?? 15_000)
      if (resync || !accumulator) {
        const snapshot = await options.snapshot(connection.signal)
        if (signal.aborted) return
        if (connection.signal.aborted) throw new DOMException('Timed out', 'AbortError')
        accumulator = new GenerationAccumulator(snapshot, options.sessionId, options.generationId, options.petId)
        update(); resync = false
      }
      if (isTerminal(accumulator.generation.state)) { options.onState('completed'); return }
      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      if (accumulator.cursor) headers['Last-Event-ID'] = accumulator.cursor
      const response = await (options.fetcher ?? fetch)(options.url,
        { method: 'GET', credentials: 'include', headers, signal: connection.signal, redirect: 'error', cache: 'no-store' })
      if (signal.aborted) return
      if (connection.signal.aborted) throw new DOMException('Timed out', 'AbortError')
      if (!response.ok) {
        const after = response.headers.get('retry-after')
        const delay = after ? (/^\d+$/.test(after) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - Date.now())) : 0
        throw new StreamHttpError(response.status, Number.isFinite(delay) ? delay : 0)
      }
      valid(response.headers.get('content-type')?.includes('text/event-stream') && response.body)
      options.onState('streaming')
      const reader = response.body.getReader()
      const decoder = new PrivateSseDecoder((frame) => {
        if (signal.aborted) return
        if (accumulator!.apply(frame) === 'applied') { activity(); update() }
      }, activity)
      try {
        while (!signal.aborted) {
          const chunk = await reader.read()
          decoder.push(chunk.value ?? new Uint8Array(), chunk.done)
          if (isTerminal(accumulator.generation.state)) { options.onState('completed'); return }
          if (chunk.done) break
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      if (!signal.aborted) throw new Error('回复连接中断，尚未收到完成确认。')
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof StreamHttpError) {
        if (error.status === 401) options.onUnauthorized()
        if ([401, 403, 404, 422].includes(error.status)) fatal = error
        else if (error.status === 410 || error.resyncSnapshot) resync = true
        retryDelay = error.retryAfter
      } else if (error instanceof StreamProtocolError || error instanceof TypeError) resync = true
      // Axios snapshot errors also preserve their HTTP status and authentication handling.
      const status = (error as { response?: { status?: number } })?.response?.status
      if (status && [401, 403, 404, 422].includes(status)) fatal = error
      failures += 1
      if (fatal || failures >= 5) { options.onState('disconnected'); throw fatal ?? error }
    } finally {
      clearTimeout(timer); connection.abort(); signal.removeEventListener('abort', abort)
    }
    options.onState('reconnecting')
    const backoff = Math.min(8000, 1000 * 2 ** (failures - 1))
    const jitter = Math.min(8000, backoff * (0.8 + Math.random() * 0.2))
    await (options.sleep ?? abortableDelay)(Math.max(retryDelay, jitter), signal)
  }
}
