/** Test-only p3-chat/1.0-draft HTTP fixture. Real P2.5 Cookie/CSRF auth is required. */
import type { Page, Route } from '@playwright/test'
import type { ChatGeneration, ChatPreferences, GenerationAccepted, StoredMessage, StoredSession } from '../../src/features/chat/api-types'

interface OwnerData {
  sessions: Map<string, StoredSession>; messages: Map<string, StoredMessage[]>; generations: Map<string, ChatGeneration>
  preferences: ChatPreferences; dismissed: string | null; deleted: Set<string>
  creates: Map<string, StoredSession>; accepts: Map<string, GenerationAccepted>
}
export interface MockOptions {
  provider?: 'mock' | 'deepseek'
  disconnectOnce?: boolean; duplicateDelta?: boolean; hold?: boolean; rejectCancel?: boolean
  sendTimeouts?: number; expireReplay?: boolean; gapOnce?: boolean; pageSize?: number
  eventsNotFound?: boolean; rateLimitOnce?: boolean; queued?: boolean; deleteDelayMs?: number; retryTimeouts?: number
  cancelReplayDelta?: boolean
  omitActiveSummary?: boolean; cancelAlreadyCompleted?: boolean; connectionGapOnce?: boolean
  finishReason?: 'stop' | 'length'; finishBeforeSnapshot?: boolean
  snapshotFailAfterCancelOnce?: boolean
  delayFirstActiveDetail?: boolean; dismissPreferenceReadDelayMs?: number; terminalDetailDelayMs?: number
  rejectFirstSend?: { status: number; code: string }
}
const prefix = '/api/v1/companion'
const finalContent = '【契约 Mock】固定本地回复；未调用真实模型。消息属于当前测试账户，不写长期记忆。'
const now = () => new Date().toISOString()
const terminal = (state: string) => ['completed', 'failed', 'cancelled'].includes(state)
const fixtureDrains = new WeakMap<Page, () => Promise<void>>()

/** Stop React requests before removing routes, then drain all live auth checks.
 * Removing routes while another handler awaits auth may let Playwright continue
 * that interception to the real server before its fixture response is ready.
 */
export async function disposeP3ChatMock(page: Page) {
  if (!page.isClosed()) await page.goto('about:blank')
  await fixtureDrains.get(page)?.()
  await page.unrouteAll({ behavior: 'wait' })
  fixtureDrains.delete(page)
}

export async function installP3ChatMock(page: Page, options: MockOptions = {}) {
  if (fixtureDrains.has(page)) throw new Error('Dispose the existing P3 fixture before installing another one.')
  const handlers = new Set<Promise<void>>()
  const owners = new Map<string, OwnerData>()
  const provider = options.provider ?? 'mock'
  const events = new Map<string, string[]>()
  const eventReads = new Map<string, number>()
  const stats = { createCalls: 0, acceptedSends: 0, sendCalls: 0, retries: 0, retryCalls: 0, cancelCalls: 0,
    getEvents: [] as { generationId: string; lastEventId: string | undefined }[], csrfChecked: 0, deleteCalls: 0, deletedSessions: 0,
    snapshots: 0, renameExpectedVersions: [] as number[], preferenceReads: 0,
    preferenceExpectedVersions: [] as number[], dismissalCalls: 0, detailVersions: [] as number[] }
  let preferenceDelay = 0
  let failedCancelledSnapshot = false
  let delayedDetail = false
  let releaseActiveDetail: () => void = () => {}
  const activeDetailCaptured = new Promise<void>((resolve) => { releaseActiveDetail = resolve })
  function owner(id: string) {
    if (!owners.has(id)) owners.set(id, { sessions: new Map(), messages: new Map(), generations: new Map(),
      preferences: { recent_topic_enabled: false, version: 0, consented_at: null }, dismissed: null,
      deleted: new Set(), creates: new Map(), accepts: new Map() })
    return owners.get(id)!
  }
  async function fulfill(route: Route, response: Parameters<Route['fulfill']>[0]) {
    try { await route.fulfill(response) }
    catch (cause) {
      // A selection change can abort this request while the real auth check is
      // awaiting its response. Chromium may report the disposed interception
      // before Playwright delivers requestfailed; only ignore that exact
      // lifecycle error once this same request is confirmed as ERR_ABORTED.
      const cancelled = () => route.request().failure()?.errorText === 'net::ERR_ABORTED'
      if (!(cause instanceof Error) || !cause.message.endsWith('Route is already handled!')) throw cause
      if (!cancelled() && !page.isClosed()) {
        try {
          await page.waitForEvent('requestfailed', { predicate: (request) => request === route.request(), timeout: 1000 })
        } catch (waitError) {
          if (!(waitError instanceof Error) || waitError.name !== 'TimeoutError') throw waitError
        }
      }
      if (!cancelled()) throw cause
    }
  }
  async function json(route: Route, data: unknown, status = 200) {
    await fulfill(route, { status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store',
      'X-WeiBiYe-Test-Fixture': 'p3-chat/1.0-draft' }, body: JSON.stringify(data) })
  }
  const error = (route: Route, status: number, code: string) => json(route,
    { error: { code, message: `契约 Mock：${code}` }, request_id: crypto.randomUUID() }, status)
  function addSession(data: OwnerData, title = '新的聊天') {
    const session: StoredSession = { id: crypto.randomUUID(), companion_id: crypto.randomUUID(), title,
      created_at: now(), updated_at: now(), last_message_at: null, last_activity_at: now(), version: 1, active_generation: null }
    data.sessions.set(session.id, session); data.messages.set(session.id, [])
    return session
  }
  function event(generation: ChatGeneration, type: string, sequence: number, extra: object) {
    return `id: ${generation.id}:${sequence}\nevent: ${type}\ndata: ${JSON.stringify({ version: 1, scope: 'generation',
      generation_id: generation.id, session_id: generation.session_id, message_id: generation.assistant_message_id,
      sequence, occurred_at: now(), ...extra })}\n\n`
  }
  function accept(data: OwnerData, session: StoredSession, input: StoredMessage, retryOf: string | null = null) {
    const list = data.messages.get(session.id)!
    const id = crypto.randomUUID()
    const message: StoredMessage = { id: crypto.randomUUID(), session_id: session.id, client_message_id: null,
      sequence: list.length, role: 'assistant', content: '', status: 'queued', provider, created_at: now(), completed_at: null, generation_id: id, finish_reason: null }
    list.push(message)
    const generation: ChatGeneration = { id, session_id: session.id, user_message_id: input.id,
      assistant_message_id: message.id, retry_of_generation_id: retryOf, state: options.queued ? 'queued' : 'running', provider, model: provider === 'mock' ? null : 'deepseek-flash',
      prompt_version: 'companion-v1', created_at: now(), started_at: options.queued ? null : now(), finished_at: null, last_event_id: `${id}:1`, error: null, finish_reason: null }
    data.generations.set(id, generation); session.active_generation = generation
    session.last_message_at = now(); session.last_activity_at = now(); session.version++
    events.set(id, [event(generation, 'start', 1, { user_message_id: input.id, state: 'queued', mode: provider === 'mock' ? 'mock' : 'real', persisted: true })])
    return { generation, user_message: input, assistant_message: message,
      events_url: `${prefix}/sessions/${session.id}/generations/${id}/events`, idempotent_replay: false }
  }
  function finish(data: OwnerData, generation: ChatGeneration, state: 'completed' | 'cancelled' | 'failed' = 'completed') {
    const message = data.messages.get(generation.session_id)!.find((item) => item.id === generation.assistant_message_id)!
    if (events.get(generation.id)!.length === 1 && state !== 'cancelled') {
      message.content = '【契约 Mock】'
      events.get(generation.id)!.push(event(generation, 'delta', 2, { text: message.content }))
    }
    const sequence = events.get(generation.id)!.length + 1
    generation.state = state; generation.finished_at = now(); generation.last_event_id = `${generation.id}:${sequence}`
    generation.error = state === 'failed' ? { code: 'GENERATION_TIMEOUT', message: '契约 Mock：回复超时', retryable: true } : null
    message.content = state === 'completed' ? finalContent : message.content
    message.status = state; message.completed_at = now()
    message.finish_reason = generation.finish_reason = state === 'completed' ? options.finishReason ?? 'stop' : null
    const session = data.sessions.get(generation.session_id)!; session.active_generation = null; session.last_activity_at = now(); session.version++
    const extra = state === 'completed' ? { state, content: message.content, finish_reason: message.finish_reason, usage: null }
      : state === 'cancelled' ? { state, content: message.content, reason: 'user_requested' }
        : { state, content: message.content, error: { code: 'GENERATION_TIMEOUT', message: '契约 Mock：回复超时', retryable: true } }
    events.get(generation.id)!.push(event(generation, state === 'failed' ? 'error' : state, sequence, extra))
  }
  function recent(data: OwnerData) {
    if (!data.preferences.recent_topic_enabled) return null
    const sessions = [...data.sessions.values()].filter((item) => !data.deleted.has(item.id)).reverse()
    for (const session of sessions) {
      const messages = data.messages.get(session.id)!
      const assistant = [...messages].reverse().find((item) => item.role === 'assistant' && item.status === 'completed')
      if (!assistant) continue
      const user = [...messages].reverse().find((item) => item.role === 'user' && item.sequence < assistant.sequence)
      if (!user) continue
      const version = `${session.id}:${user.id}:${assistant.id}`
      if (data.dismissed === version) return null
      return { conversation_id: session.id, title: session.title, summary: [...user.content].slice(0, 80).join(''),
        last_message_at: assistant.completed_at, follow_up_text: '如果你愿意，我们可以从上次的这段话接着聊。',
        dismissed: false, source: 'message-excerpt', source_message_ids: [user.id, assistant.id], summary_version: version }
    }
    return null
  }
  const handleRoute = async (route: Route) => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method()
    if (url.pathname === `${prefix}/demo/stream`) { await route.continue(); return }
    const identity = await page.request.get('/api/v1/auth/me')
    if (identity.status() !== 200) { await error(route, 401, 'AUTHENTICATION_REQUIRED'); return }
    const user = await identity.json() as { id: string }
    const data = owner(user.id)
    const body = method === 'GET' || method === 'DELETE' ? {} : request.postDataJSON() as Record<string, unknown>
    if (method !== 'GET') {
      const csrf = await page.request.get('/api/v1/auth/csrf')
      const token = (await csrf.json() as { csrf_token: string }).csrf_token
      if (csrf.status() !== 200 || request.headers()['x-csrf-token'] !== token
        || request.headers().origin !== url.origin) { await error(route, 403, 'CSRF_REJECTED'); return }
      stats.csrfChecked++
      if (Object.keys(body).some((key) => ['owner_id', 'user_id', 'provider', 'model', 'role', 'system_prompt'].includes(key))) {
        await error(route, 422, 'VALIDATION_ERROR'); return
      }
    }
    const key = request.headers()['idempotency-key']
    const ik = () => typeof key === 'string' && key.length >= 16 && key.length <= 120
    const path = url.pathname.slice(prefix.length)
    if (path === '/runtime' && method === 'GET') {
      await json(route, { schema_version: 'chat-runtime/1', provider, model: provider === 'mock' ? null : 'deepseek-flash',
        mode: provider === 'mock' ? 'mock' : 'real', billing: provider === 'mock' ? 'none' : 'external_provider', memory_injection_enabled: false }); return
    }
    if (path === '/preferences') {
      if (method === 'GET') {
        stats.preferenceReads++
        const delay = preferenceDelay; preferenceDelay = 0
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      }
      if (method === 'PATCH') {
        stats.preferenceExpectedVersions.push(Number(body.expected_version))
        if (body.expected_version !== data.preferences.version) { await error(route, 409, 'VERSION_CONFLICT'); return }
        const enabled = body.recent_topic_enabled === true
        if (enabled && !data.preferences.recent_topic_enabled) data.dismissed = null
        data.preferences = { recent_topic_enabled: enabled, version: data.preferences.version + 1, consented_at: enabled ? now() : null }
      }
      await json(route, data.preferences); return
    }
    if (path === '/recent-topic') { await json(route, { item: recent(data) }); return }
    if (path === '/sessions' && method === 'POST') {
      if (!ik()) { await error(route, 422, 'VALIDATION_ERROR'); return }
      let session = data.creates.get(key!)
      const replay = !!session
      if (session && data.deleted.has(session.id)) { await error(route, 409, 'RESOURCE_DELETED'); return }
      if (!session) { session = addSession(data); data.creates.set(key!, session); stats.createCalls++ }
      await json(route, { session, idempotent_replay: replay }, 201); return
    }
    if (path === '/sessions' && method === 'GET') {
      const all = [...data.sessions.values()].filter((session) => !data.deleted.has(session.id)).reverse()
      const cursor = url.searchParams.get('cursor'); const offset = cursor ? Number(Buffer.from(cursor, 'base64url').toString().split(':').at(-1)) : 0
      const limit = options.pageSize ?? 30; const items = all.slice(offset, offset + limit)
      const more = offset + limit < all.length
      await json(route, { items, has_more: more, next_cursor: more ? Buffer.from(`${user.id}:${offset + limit}`).toString('base64url') : null }); return
    }
    const match = /^\/sessions\/([^/]+)(.*)$/.exec(path)
    const session = match && data.sessions.get(match[1])
    if (!match || !session || data.deleted.has(session.id)) { await error(route, 404, 'RESOURCE_NOT_FOUND'); return }
    const tail = match[2]
    if (!tail) {
      if (method === 'GET') {
        stats.detailVersions.push(session.version)
        if (options.delayFirstActiveDetail && session.active_generation && !delayedDetail) {
          delayedDetail = true
          const captured = JSON.parse(JSON.stringify(session)) as StoredSession
          releaseActiveDetail()
          await new Promise((resolve) => setTimeout(resolve, 250))
          await json(route, captured); return
        }
        if (options.terminalDetailDelayMs && !session.active_generation && session.last_message_at) {
          const captured = JSON.parse(JSON.stringify(session)) as StoredSession
          await new Promise((resolve) => setTimeout(resolve, options.terminalDetailDelayMs))
          await json(route, captured); return
        }
      }
      if (method === 'DELETE') {
        stats.deleteCalls++
        if (options.deleteDelayMs) await new Promise((resolve) => setTimeout(resolve, options.deleteDelayMs))
        data.deleted.add(session.id); stats.deletedSessions++
        await fulfill(route, { status: 204 })
        return
      }
      if (method === 'PATCH') {
        stats.renameExpectedVersions.push(Number(body.expected_version))
        if (body.expected_version !== session.version) { await error(route, 409, 'VERSION_CONFLICT'); return }
        session.title = String(body.title); session.version++
      }
      await json(route, options.omitActiveSummary ? { ...session, active_generation: null } : session); return
    }
    if (tail === '/topic-dismissals') {
      stats.dismissalCalls++
      const item = recent(data)
      if (body.summary_version === data.dismissed) { await fulfill(route, { status: 204 }); return }
      if (!item || item.summary_version !== body.summary_version) { await error(route, 409, 'TOPIC_STALE'); return }
      data.dismissed = item.summary_version; data.preferences.version++
      preferenceDelay = options.dismissPreferenceReadDelayMs ?? 0
      await fulfill(route, { status: 204 }); return
    }
    if (tail === '/messages' && method === 'GET') {
      const list = data.messages.get(session.id)!
      const cursor = url.searchParams.get('cursor'); const end = cursor ? Number(Buffer.from(cursor, 'base64url').toString().split(':').at(-1)) : list.length
      const start = Math.max(0, end - (options.pageSize ? 2 : 50))
      await json(route, { items: list.slice(start, end), has_more: start > 0,
        next_cursor: start > 0 ? Buffer.from(`${user.id}:${session.id}:${start}`).toString('base64url') : null }); return
    }
    if ((tail === '/messages' || tail === '/generations') && method === 'POST') {
      if (!ik()) { await error(route, 422, 'VALIDATION_ERROR'); return }
      const composite = `${session.id}:${tail}:${key}`
      let accepted = data.accepts.get(composite)
      if (tail === '/messages') stats.sendCalls++
      if (tail === '/generations') stats.retryCalls++
      if (tail === '/messages' && options.rejectFirstSend && stats.sendCalls === 1) {
        await error(route, options.rejectFirstSend.status, options.rejectFirstSend.code); return
      }
      if (tail === '/messages' && options.rateLimitOnce && stats.sendCalls === 1) {
        await fulfill(route, { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
          body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: '契约 Mock：请稍后重试。' }, request_id: crypto.randomUUID() }) }); return
      }
      if (!accepted) {
        if (session.active_generation) { await error(route, 409, 'GENERATION_IN_PROGRESS'); return }
        const messages = data.messages.get(session.id)!
        let input: StoredMessage
        if (tail === '/messages') {
          if (messages.some((item) => item.client_message_id === body.client_message_id)) { await error(route, 409, 'DUPLICATE_CLIENT_MESSAGE'); return }
          input = { id: crypto.randomUUID(), session_id: session.id, client_message_id: String(body.client_message_id), sequence: messages.length,
            role: 'user', content: String(body.content), status: 'completed', provider: null, created_at: now(), completed_at: now(), generation_id: null, finish_reason: null }
          messages.push(input); stats.acceptedSends++
        } else {
          const previous = data.generations.get(String(body.retry_of_generation_id))
          if (!previous || !['cancelled', 'failed'].includes(previous.state)) { await error(route, 409, 'RETRY_NOT_ALLOWED'); return }
          input = messages.find((item) => item.id === previous.user_message_id)!; stats.retries++
        }
        accepted = accept(data, session, input, tail === '/generations' ? String(body.retry_of_generation_id) : null)
        data.accepts.set(composite, accepted)
      }
      if (tail === '/messages' && stats.sendCalls <= (options.sendTimeouts ?? 0)) { await route.abort('timedout'); return }
      if (tail === '/generations' && stats.retryCalls <= (options.retryTimeouts ?? 0)) { await route.abort('timedout'); return }
      await json(route, { ...accepted, idempotent_replay: stats.sendCalls > 1 }, 202); return
    }
    const generationMatch = /^\/generations\/([^/]+)(.*)$/.exec(tail)
    const generation = generationMatch && data.generations.get(generationMatch[1])
    if (!generationMatch || !generation || generation.session_id !== session.id) { await error(route, 404, 'RESOURCE_NOT_FOUND'); return }
    const message = data.messages.get(session.id)!.find((item) => item.id === generation.assistant_message_id)!
    if (!generationMatch[2]) {
      stats.snapshots++
      if (options.snapshotFailAfterCancelOnce && stats.cancelCalls > 0 && terminal(generation.state) && !failedCancelledSnapshot) {
        failedCancelledSnapshot = true; await error(route, 503, 'CHAT_STORAGE_UNAVAILABLE'); return
      }
      if (options.finishBeforeSnapshot && !terminal(generation.state)) finish(data, generation)
      await json(route, { generation, assistant_message: message, resume_after_event_id: generation.last_event_id }); return
    }
    if (generationMatch[2] === '/cancel') {
      stats.cancelCalls++
      if (options.rejectCancel) { await error(route, 503, 'CHAT_STORAGE_UNAVAILABLE'); return }
      if (terminal(generation.state)) { await json(route, { generation }); return }
      if (options.cancelAlreadyCompleted) { finish(data, generation); await json(route, { generation }); return }
      if (generation.state === 'queued') { finish(data, generation, 'cancelled'); await json(route, { generation }); return }
      if (options.cancelReplayDelta) {
        const sequence = events.get(generation.id)!.length + 1
        const text = '取消确认前已提交的片段'
        message.content += text; message.status = 'streaming'; generation.last_event_id = `${generation.id}:${sequence}`
        events.get(generation.id)!.push(event(generation, 'delta', sequence, { text }))
      }
      generation.state = 'cancel_requested'; await json(route, { generation }, 202)
      setTimeout(() => { if (!terminal(generation.state)) finish(data, generation, 'cancelled') }, options.cancelReplayDelta ? 2500 : 100)
      return
    }
    if (generationMatch[2] === '/events') {
      if (options.eventsNotFound) { await error(route, 404, 'RESOURCE_NOT_FOUND'); return }
      const count = (eventReads.get(generation.id) ?? 0) + 1; eventReads.set(generation.id, count)
      stats.getEvents.push({ generationId: generation.id, lastEventId: request.headers()['last-event-id'] })
      if (options.delayFirstActiveDetail) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([activeDetailCaptured, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Contract fixture did not capture the active session detail.')), 5000)
          })])
        } finally { clearTimeout(timer) }
      }
      if (generation.state === 'queued') { await fulfill(route, { contentType: 'text/event-stream', body: ': ping\n\n' }); return }
      if (options.expireReplay && count === 1) { finish(data, generation); await error(route, 410, 'EVENT_REPLAY_EXPIRED'); return }
      const frames = events.get(generation.id)!
      if (frames.length === 1) {
        message.content = '【契约 Mock】'; message.status = 'streaming'; generation.last_event_id = `${generation.id}:2`
        frames.push(event(generation, 'delta', 2, { text: message.content }))
      }
      if (options.connectionGapOnce && count === 1) {
        await fulfill(route, { contentType: 'text/event-stream', body: 'event: error\ndata: {"version":1,"scope":"connection","error":{"code":"STREAM_UNAVAILABLE","message":"读取已保存快照后重连。","retryable":true}}\n\n' }); return
      }
      if (!terminal(generation.state) && !options.hold && !(options.disconnectOnce && count === 1) && !(options.gapOnce && count === 1)) finish(data, generation)
      const after = Number(request.headers()['last-event-id']?.split(':').at(-1) ?? 0)
      let body = frames.filter((item) => Number(item.split('\n')[0].split(':').at(-1)) > after).join('')
      if (options.duplicateDelta && count === 1) body = frames[1] + frames[1] + frames.slice(2).join('')
      if (options.gapOnce && count === 1) body = event(generation, 'delta', 3, { text: '缺口不得直接展示' })
      await fulfill(route, { contentType: 'text/event-stream', headers: { 'Cache-Control': 'no-cache, no-store',
        'X-WeiBiYe-Test-Fixture': 'p3-chat/1.0-draft' }, body: body || ': ping\n\n' }); return
    }
    await error(route, 404, 'RESOURCE_NOT_FOUND')
  }
  await page.route('**/api/v1/companion/**', async (route) => {
    const operation = handleRoute(route); handlers.add(operation)
    try { await operation } finally { handlers.delete(operation) }
  })
  fixtureDrains.set(page, async () => {
    // Keep interception installed until all registered handlers have completed.
    // Failures still propagate; this is neither ignoreErrors nor a blanket catch.
    while (handlers.size) await Promise.all([...handlers])
  })
  return {
    dispose: () => disposeP3ChatMock(page),
    stats,
    async seed(title: string, turns = 1, state: 'completed' | 'failed' = 'completed') {
      const response = await page.request.get('/api/v1/auth/me'); const identity = await response.json() as { id: string }
      const data = owner(identity.id); const session = addSession(data, title)
      for (let index = 0; index < turns; index++) {
        const list = data.messages.get(session.id)!
        const input: StoredMessage = { id: crypto.randomUUID(), session_id: session.id, client_message_id: crypto.randomUUID(), sequence: list.length,
          role: 'user', content: `契约测试历史 ${index + 1}`, status: 'completed', provider: null, created_at: now(), completed_at: now(), generation_id: null, finish_reason: null }
        list.push(input); const accepted = accept(data, session, input); finish(data, accepted.generation, state)
      }
      return session.id
    },
    async renameElsewhere(sessionId: string, title: string) {
      const identity = await (await page.request.get('/api/v1/auth/me')).json() as { id: string }
      const session = owner(identity.id).sessions.get(sessionId)!
      session.title = title; session.version++
    },
    async preferencesElsewhere(enabled: boolean, nextReadDelay = 0) {
      const identity = await (await page.request.get('/api/v1/auth/me')).json() as { id: string }
      const data = owner(identity.id)
      data.preferences = { recent_topic_enabled: enabled, version: data.preferences.version + 1, consented_at: enabled ? now() : null }
      preferenceDelay = nextReadDelay
    },
    async appendElsewhere(sessionId: string, content: string) {
      const identity = await (await page.request.get('/api/v1/auth/me')).json() as { id: string }
      const data = owner(identity.id); const session = data.sessions.get(sessionId)!
      const list = data.messages.get(sessionId)!
      const input: StoredMessage = { id: crypto.randomUUID(), session_id: sessionId, client_message_id: crypto.randomUUID(), sequence: list.length,
        role: 'user', content, status: 'completed', provider: null, created_at: now(), completed_at: now(), generation_id: null, finish_reason: null }
      list.push(input); const accepted = accept(data, session, input); finish(data, accepted.generation)
    },
    failLastGeneration() {
      for (const data of owners.values()) for (const generation of data.generations.values()) if (!terminal(generation.state)) finish(data, generation, 'failed')
    },
  }
}
