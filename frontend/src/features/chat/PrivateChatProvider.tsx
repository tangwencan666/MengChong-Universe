import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import axios from 'axios'
import { errorMessage } from '../../lib/api'
import { ChatContext } from './context'
import { createChatApi } from './api'
import type { ChatGeneration, ChatPreferences, GenerationAccepted, StoredMessage, StoredSession } from './api-types'
import { isTerminal } from './api-types'
import { sameRuntime } from './provider-presentation'
import { createSendIntent, currentSessionGeneration, GenerationRetryKeys, normalizeChatText, retryAfterMilliseconds, retryNetworkOnce } from './commands'
import type { SendIntent } from './commands'
import { GenerationAccumulator, StreamHttpError, watchGeneration } from './private-stream'
import type { ChatMessage, ChatSession, RecentConversationSummary } from './types'

function viewMessage(message: StoredMessage, generation?: ChatGeneration, finishReason?: string | null): ChatMessage {
  return { id: message.id, role: message.role, content: message.content,
    status: message.status === 'queued' ? 'queued' : message.status === 'completed' ? 'complete' : message.status === 'failed' ? 'error'
      : message.status === 'cancelled' ? 'interrupted' : 'streaming',
    generationId: message.generation_id ?? undefined, provider: message.provider,
    finishReason: finishReason ?? message.finish_reason ?? null,
    error: message.status === 'failed' ? generation?.error?.message ?? '这次回复未完成。可明确选择重新生成。'
      : message.status === 'cancelled' ? '已停止生成，当前回复可能不完整。' : undefined }
}
const networkFailure = (cause: unknown) => axios.isAxiosError(cause) && !cause.response && !axios.isCancel(cause)

export function PrivateChatProvider({ owner, scopeVersion, children, petId }:
  { owner: string; scopeVersion: number; children: ReactNode; petId?: string }) {
  const boundApi = useRef(createChatApi(petId))
  const home = petId ? `/pets/${petId}` : '/'
  const queries = useQueryClient()
  const navigate = useNavigate()
  const root = useMemo(() => ['private-chat', owner, scopeVersion, petId ?? 'legacy'] as const, [owner, scopeVersion, petId])
  const alive = useRef(true)
  const controllers = useRef(new Set<AbortController>())
  const stream = useRef<AbortController | null>(null)
  const selection = useRef<string | undefined>(undefined)
  const epoch = useRef(0)
  const pending = useRef<SendIntent | null>(null)
  const sending = useRef<Promise<string> | null>(null)
  const retryKeys = useRef(new GenerationRetryKeys())
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focusRefresh = useRef<Promise<void> | null>(null)
  const focusController = useRef<AbortController | null>(null)
  const preferenceWrite = useRef(false)
  const preferenceNeedsRefresh = useRef(false)
  const [selected, setSelected] = useState<string>()
  const [live, setLive] = useState<Record<string, StoredMessage>>({})
  const [generation, setGeneration] = useState<ChatGeneration | null>(null)
  const [finishReason, setFinishReason] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [hasPendingSend, setHasPendingSend] = useState(false)
  const [retryBlocked, setRetryBlocked] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelRequestedId, setCancelRequestedId] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState('idle')
  const [reconnectVersion, setReconnectVersion] = useState(0)
  const [savingPreference, setSavingPreference] = useState(false)
  const [requestedPreference, setRequestedPreference] = useState<boolean | null>(null)
  const [preferenceError, setPreferenceError] = useState('')
  const [consentOverride, setConsentOverride] = useState<boolean | null>(null)
  const [consentUnconfirmed, setConsentUnconfirmed] = useState(false)
  const [hiddenTopic, setHiddenTopic] = useState<string | null>(null)
  const [removed, setRemoved] = useState<Set<string>>(new Set())

  useEffect(() => {
    alive.current = true
    const operations = controllers.current
    const generationRetryKeys = retryKeys.current
    return () => {
      alive.current = false; epoch.current += 1; stream.current?.abort()
      for (const controller of operations) controller.abort()
      operations.clear(); pending.current = null; generationRetryKeys.clear()
      clearTimeout(throttleTimer.current)
      void queries.cancelQueries({ queryKey: root })
      queries.removeQueries({ queryKey: root })
    }
  }, [queries, root])

  const respectThrottle = useCallback((cause: unknown) => {
    if (!alive.current || !axios.isAxiosError(cause) || cause.response?.status !== 429) return
    const delay = retryAfterMilliseconds(String(cause.response.headers['retry-after'] ?? ''))
    if (!delay) return
    clearTimeout(throttleTimer.current); setRetryBlocked(true)
    throttleTimer.current = setTimeout(() => { if (alive.current) setRetryBlocked(false) }, delay)
  }, [])

  const history = useInfiniteQuery({ queryKey: [...root, 'sessions'], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => boundApi.current.sessions(pageParam, signal),
    getNextPageParam: (last) => last.has_more ? last.next_cursor ?? undefined : undefined, retry: false })
  const runtime = useQuery({ queryKey: [...root, 'runtime'],
    queryFn: ({ signal }) => boundApi.current.runtime(signal), retry: false })
  // An old history entry is not evidence of the provider that will handle a new request.
  const confirmedRuntime = runtime.isError ? null : runtime.data ?? null
  const confirmRuntime = useCallback(async (signal: AbortSignal) => {
    if (!confirmedRuntime) throw new Error('请先确认聊天模型配置，再发送新消息。')
    const current = await queries.fetchQuery({ queryKey: [...root, 'runtime'], staleTime: 0, retry: false,
      queryFn: () => boundApi.current.runtime(signal) })
    // A backend restart must not silently turn an already displayed free Mock
    // action into a billable request. Refresh disclosure and require another click.
    if (!sameRuntime(current, confirmedRuntime)) throw new Error('聊天模型配置已变化，请查看更新后的说明，再决定是否发送。')
  }, [confirmedRuntime, queries, root])
  const detail = useQuery({ queryKey: [...root, 'session', selected], enabled: !!selected,
    queryFn: ({ signal }) => boundApi.current.session(selected!, signal), retry: false })
  const messages = useInfiniteQuery({ queryKey: [...root, 'messages', selected], enabled: !!selected,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => boundApi.current.messages(selected!, pageParam, signal),
    getNextPageParam: (last) => last.has_more ? last.next_cursor ?? undefined : undefined, retry: false })
  const preferences = useQuery({ queryKey: [...root, 'preferences'], enabled: !petId, queryFn: ({ signal }) => boundApi.current.preferences(signal), retry: false })
  const enabled = !petId && !consentUnconfirmed && !preferences.isError
    && (consentOverride ?? preferences.data?.recent_topic_enabled ?? false)
  const topic = useQuery({ queryKey: [...root, 'recent-topic'], enabled,
    queryFn: ({ signal }) => boundApi.current.recentTopic(signal), retry: false })

  const refresh = useCallback(() => {
    void queries.invalidateQueries({ queryKey: [...root, 'sessions'] })
    void queries.invalidateQueries({ queryKey: [...root, 'recent-topic'] })
  }, [queries, root])
  const refreshSessionDetail = useCallback(async (id: string, expectedEpoch: number) => {
    const current = () => alive.current && selection.current === id && epoch.current === expectedEpoch
    if (!current()) return
    // Invalidating an initial, still-pending fetch does not replace it. Cancel
    // that older snapshot explicitly before requesting the terminal version.
    await queries.cancelQueries({ queryKey: [...root, 'session', id], exact: true })
    if (current()) await queries.invalidateQueries({ queryKey: [...root, 'session', id], exact: true })
  }, [queries, root])
  const selectSession = useCallback((id?: string) => {
    if (selection.current === id) return
    const previous = selection.current
    selection.current = id; epoch.current += 1
    stream.current?.abort()
    for (const controller of controllers.current) controller.abort()
    if (previous) {
      void queries.cancelQueries({ queryKey: [...root, 'session', previous] })
      void queries.cancelQueries({ queryKey: [...root, 'messages', previous] })
    }
    setSelected(id); setLive({}); setGeneration(null); setFinishReason(null)
    setConnectionState('idle'); setActionError(''); setCancelling(false); setCancelRequestedId(null)
  }, [queries, root])

  const forgetSession = useCallback((id: string) => {
    // Clear the selected ref before cancellation emits nested query-cache events.
    selectSession()
    stream.current?.abort()
    void queries.cancelQueries({ queryKey: [...root, 'session', id] })
    void queries.cancelQueries({ queryKey: [...root, 'messages', id] })
    queries.removeQueries({ queryKey: [...root, 'session', id] })
    queries.removeQueries({ queryKey: [...root, 'messages', id] })
    queries.removeQueries({ queryKey: [...root, 'recent-topic'] })
    setRemoved((previous) => new Set([...previous, id]))
    navigate(home, { replace: true })
    setActionError('这段会话当前不可读取。'); refresh()
  }, [queries, root, selectSession, navigate, refresh, home])

  // A fast task may finish before the first session GET, which then has no active
  // summary. An accepted command must still reconcile its own authoritative snapshot.
  const activeId = detail.data?.active_generation?.id
    ?? (generation && generation.session_id === selected ? generation.id : undefined)
  const currentGeneration = currentSessionGeneration(detail.data?.active_generation, generation, selected)
  useEffect(() => {
    if (!selected || !activeId) return
    const controller = new AbortController(); stream.current = controller
    const ownEpoch = epoch.current
    const current = () => alive.current && !controller.signal.aborted
      && selection.current === selected && epoch.current === ownEpoch
    void watchGeneration({ petId, sessionId: selected, generationId: activeId,
      url: boundApi.current.eventsUrl(selected, activeId), signal: controller.signal,
      snapshot: (signal) => boundApi.current.snapshot(selected, activeId, signal),
      onUpdate: (message, next, reason) => {
        if (!current()) return
        setLive((previous) => ({ ...previous, [message.id]: message }))
        setGeneration(next); setFinishReason(reason)
        if (isTerminal(next.state)) {
          setCancelling(false)
          setCancelRequestedId((previous) => previous === next.id ? null : previous)
          refresh()
          void refreshSessionDetail(selected, ownEpoch)
          // Keep the terminal snapshot locally; do not race a stale history response.
        }
      },
      onState: (state) => { if (current()) setConnectionState(state) },
      onUnauthorized: () => { if (current()) window.dispatchEvent(new Event('weibiye:unauthenticated')) },
    }).catch((cause: unknown) => {
      if (!current()) return
      const status = cause instanceof StreamHttpError ? cause.status : axios.isAxiosError(cause) ? cause.response?.status : undefined
      if (status === 404) forgetSession(selected)
      else setActionError(errorMessage(cause))
    })
    return () => controller.abort()
  }, [selected, activeId, reconnectVersion, refresh, forgetSession, refreshSessionDetail, petId])

  useEffect(() => {
    function focused() {
      if (focusRefresh.current || preferenceWrite.current || !alive.current) return
      // Hide cached suggestions until both consent and the topic are revalidated.
      // Another tab may have revoked consent, deleted a source or sent a new turn.
      setConsentUnconfirmed(true)
      void queries.invalidateQueries({ queryKey: [...root, 'sessions'] })
      const id = selection.current
      if (id) {
        stream.current?.abort(); setLive({}); setGeneration(null); setFinishReason(null)
        setReconnectVersion((value) => value + 1)
        void queries.invalidateQueries({ queryKey: [...root, 'session', id] })
        void queries.invalidateQueries({ queryKey: [...root, 'messages', id] })
      }
      if (petId) return
      const controller = new AbortController(); controllers.current.add(controller); focusController.current = controller
      const operation = async () => {
        try {
          await queries.cancelQueries({ queryKey: [...root, 'preferences'], exact: true })
          await queries.cancelQueries({ queryKey: [...root, 'recent-topic'], exact: true })
          if (controller.signal.aborted) return
          const latest = await queries.fetchQuery({ queryKey: [...root, 'preferences'], staleTime: 0, retry: false,
            queryFn: () => boundApi.current.preferences(controller.signal) })
          if (controller.signal.aborted || !alive.current) return
          if (latest.recent_topic_enabled) {
            await queries.fetchQuery({ queryKey: [...root, 'recent-topic'], staleTime: 0, retry: false,
              queryFn: () => boundApi.current.recentTopic(controller.signal) })
          } else queries.removeQueries({ queryKey: [...root, 'recent-topic'], exact: true })
          if (!controller.signal.aborted && alive.current) setConsentUnconfirmed(false)
        } catch {
          // Remain closed on a failed revalidation; query errors offer a retry.
        } finally {
          controllers.current.delete(controller); focusRefresh.current = null
          if (focusController.current === controller) focusController.current = null
        }
      }
      focusRefresh.current = operation()
    }
    function visible() { if (document.visibilityState === 'visible') focused() }
    window.addEventListener('focus', focused)
    document.addEventListener('visibilitychange', visible)
    return () => { window.removeEventListener('focus', focused); document.removeEventListener('visibilitychange', visible) }
  }, [queries, root, petId])

  useEffect(() => {
    return queries.getQueryCache().subscribe((event) => {
      const id = selection.current
      const key = event.query.queryKey
      const cause = event.query.state.error
      if (event.type !== 'updated' || !id || key[0] !== root[0] || key[1] !== owner || key[2] !== scopeVersion || key[3] !== (petId ?? 'legacy')
        || !['session', 'messages'].includes(String(key[4])) || key[5] !== id
        || !axios.isAxiosError(cause) || cause.response?.status !== 404) return
      forgetSession(id)
    })
  }, [queries, root, owner, scopeVersion, forgetSession, petId])

  const accept = useCallback((data: GenerationAccepted, id: string, expectedClientId?: string) => {
    if (data.generation.session_id !== id || data.user_message.session_id !== id || data.assistant_message.session_id !== id
      || data.user_message.role !== 'user' || data.assistant_message.role !== 'assistant'
      || data.assistant_message.id !== data.generation.assistant_message_id
      || data.user_message.id !== data.generation.user_message_id
      || (expectedClientId && data.user_message.client_message_id !== expectedClientId)) {
      throw new Error('聊天接受结果与当前请求不匹配，已停止展示。')
    }
    selectSession(id)
    setLive((previous) => ({ ...previous, [data.user_message.id]: data.user_message, [data.assistant_message.id]: data.assistant_message }))
    setGeneration(data.generation)
    queries.setQueryData<StoredSession>([...root, 'session', id], (previous) => previous
      ? { ...previous, active_generation: data.generation } : undefined)
    void queries.invalidateQueries({ queryKey: [...root, 'session', id] })
    refresh()
  }, [queries, root, selectSession, refresh])

  const executeSend = useCallback((intent: SendIntent): Promise<string> => {
    if (!confirmedRuntime) return Promise.reject(new Error('请先确认聊天模型配置，再发送新消息。'))
    if (retryBlocked) return Promise.reject(new Error('请按限流提示稍后重试原请求。'))
    if (sending.current) return sending.current
    const controller = new AbortController(); controllers.current.add(controller)
    const ownEpoch = epoch.current
    setIsSending(true); setActionError('')
    const operation = async () => {
      try {
        await confirmRuntime(controller.signal)
        if (!intent.sessionId) {
          const created = await retryNetworkOnce(() => boundApi.current.createSession(intent.createKey, controller.signal), networkFailure, controller.signal)
          intent.sessionId = created.session.id
        }
        const id = intent.sessionId
        const data = await retryNetworkOnce(() => boundApi.current.send(id, intent.content, intent.clientMessageId,
          intent.messageKey, controller.signal), networkFailure, controller.signal)
        if (!alive.current || controller.signal.aborted || ownEpoch !== epoch.current) throw new DOMException('Aborted', 'AbortError')
        controllers.current.delete(controller)
        accept(data, id, intent.clientMessageId)
        pending.current = null; setHasPendingSend(false)
        return id
      } catch (cause) {
        respectThrottle(cause)
        const status = axios.isAxiosError(cause) ? cause.response?.status : undefined
        const rejected = status !== undefined && status >= 400 && status < 500 && status !== 429
        if (rejected && pending.current === intent) {
          pending.current = null
          if (alive.current) setHasPendingSend(false)
        }
        if (status === 409) {
          refresh()
          if (intent.sessionId) void queries.invalidateQueries({ queryKey: [...root, 'messages', intent.sessionId] })
        }
        if (alive.current && ownEpoch === epoch.current && !controller.signal.aborted) {
          setActionError(`${errorMessage(cause)}${rejected
            ? ' 请核对输入或刷新会话历史后再发送。'
            : ' 请重试原请求；将复用原消息标识，不会另建一条输入。'}`)
        }
        throw cause
      } finally {
        controllers.current.delete(controller); sending.current = null
        if (alive.current) setIsSending(false)
      }
    }
    const result = operation(); sending.current = result
    return result
  }, [accept, queries, root, refresh, respectThrottle, retryBlocked, confirmedRuntime, confirmRuntime])

  const sendMessage = useCallback((raw: string, id?: string) => {
    const content = normalizeChatText(raw)
    if (sending.current) return sending.current
    if (pending.current && (pending.current.content !== content || (id && pending.current.sessionId !== id))) {
      throw new Error('上一条发送结果尚未确认，请先重试原请求。')
    }
    const intent = pending.current ?? createSendIntent(content, id)
    pending.current = intent; setHasPendingSend(true)
    return executeSend(intent)
  }, [executeSend])

  const stopGeneration = useCallback(async () => {
    const id = selection.current
    const current = currentGeneration
    if (!id || !current || current.session_id !== id || isTerminal(current.state)
      || cancelling || cancelRequestedId === current.id) return
    const controller = new AbortController(); controllers.current.add(controller)
    const ownEpoch = epoch.current; setCancelling(true); setActionError('')
    let terminalAccepted = false
    try {
      const { generation: next } = await boundApi.current.cancel(id, current.id, controller.signal)
      if (!alive.current || ownEpoch !== epoch.current) return
      if (next.id !== current.id || next.session_id !== id) throw new Error('停止结果与当前任务不匹配。')
      setGeneration(next)
      setCancelRequestedId(next.state === 'cancel_requested' ? next.id : null)
      if (isTerminal(next.state)) {
        terminalAccepted = true
        // A queued cancellation (or a completion winning the race) can have no
        // active session summary. Reconcile its saved message directly rather
        // than depending on the stream effect remaining mounted.
        stream.current?.abort()
        const saved = new GenerationAccumulator(await boundApi.current.snapshot(id, current.id, controller.signal), id, current.id, petId)
        if (!alive.current || controller.signal.aborted || ownEpoch !== epoch.current) return
        setLive((previous) => ({ ...previous, [saved.message.id]: saved.message }))
        setGeneration(saved.generation); setFinishReason(saved.finishReason)
        setConnectionState(isTerminal(saved.generation.state) ? 'completed' : 'reconnecting')
        setCancelRequestedId(saved.generation.state === 'cancel_requested' ? saved.generation.id : null)
        refresh()
        void refreshSessionDetail(id, ownEpoch)
      }
    } catch (cause) {
      respectThrottle(cause)
      if (alive.current && ownEpoch === epoch.current && !controller.signal.aborted) {
        if (terminalAccepted) {
          // The command succeeded, but its saved text still needs a GET. The
          // old stream was aborted and cannot expose its own retry control.
          setConnectionState('disconnected')
          setActionError(`任务已结束，回复内容尚未同步：${errorMessage(cause)}`)
        } else setActionError(`停止未确认：${errorMessage(cause)}`)
      }
    } finally {
      controllers.current.delete(controller)
      if (alive.current && ownEpoch === epoch.current) setCancelling(false)
    }
  }, [currentGeneration, cancelling, cancelRequestedId, respectThrottle, refresh, refreshSessionDetail, petId])

  const removeSession = useCallback(async (id: string) => {
    const controller = new AbortController(); controllers.current.add(controller)
    try {
      await boundApi.current.remove(id, controller.signal)
      if (!alive.current || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      setRemoved((previous) => new Set([...previous, id]))
      controllers.current.delete(controller)
      if (selection.current === id) selectSession()
      await queries.cancelQueries({ queryKey: [...root, 'session', id] })
      await queries.cancelQueries({ queryKey: [...root, 'messages', id] })
      queries.removeQueries({ queryKey: [...root, 'session', id] })
      queries.removeQueries({ queryKey: [...root, 'messages', id] })
      queries.removeQueries({ queryKey: [...root, 'recent-topic'] })
      refresh()
      if (!alive.current || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    } finally { controllers.current.delete(controller) }
  }, [queries, root, selectSession, refresh])

  const prepareRename = useCallback(async (id: string) => {
    const controller = new AbortController(); controllers.current.add(controller)
    const ownEpoch = epoch.current
    try {
      // Read before displaying the editor, never immediately before saving it.
      // Opening while the completion refresh is pending must not capture an old
      // version, but edits made after opening still require optimistic locking.
      const current = await boundApi.current.session(id, controller.signal)
      if (!alive.current || controller.signal.aborted || ownEpoch !== epoch.current) throw new DOMException('Aborted', 'AbortError')
      if (current.id !== id || typeof current.title !== 'string' || !Number.isInteger(current.version) || current.version < 1) {
        throw new Error('会话标题或版本尚未确认，请重新加载历史。')
      }
      queries.setQueryData<StoredSession>([...root, 'session', id], (previous) =>
        previous && previous.version > current.version ? previous : current)
      return { title: current.title, version: current.version }
    } finally { controllers.current.delete(controller) }
  }, [queries, root])

  const rename = useCallback(async (id: string, raw: string, expectedVersion: number) => {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new Error('会话版本尚未确认，请重新加载历史。')
    const controller = new AbortController(); controllers.current.add(controller)
    try {
      const updated = await boundApi.current.rename(id, normalizeChatText(raw, 120), expectedVersion, controller.signal)
      if (!alive.current || controller.signal.aborted) return
      queries.setQueryData([...root, 'session', id], updated); refresh()
    } catch (cause) { refresh(); throw cause }
    finally { controllers.current.delete(controller) }
  }, [queries, root, refresh])

  const retryGeneration = useCallback(async (generationId: string) => {
    const id = selection.current
    if (!id || sending.current || isSending || retryBlocked || !confirmedRuntime) return
    const key = retryKeys.current.keyFor(id, generationId)
    const controller = new AbortController(); controllers.current.add(controller)
    const ownEpoch = epoch.current; setIsSending(true); setActionError('')
    try {
      await confirmRuntime(controller.signal)
      const data = await retryNetworkOnce(() => boundApi.current.retry(id, generationId, key, controller.signal), networkFailure, controller.signal)
      if (!alive.current || controller.signal.aborted || ownEpoch !== epoch.current) return
      accept(data, id); retryKeys.current.confirm(id, generationId); setReconnectVersion((value) => value + 1)
    } catch (cause) {
      respectThrottle(cause)
      if (alive.current && ownEpoch === epoch.current && !controller.signal.aborted) setActionError(errorMessage(cause))
    } finally {
      controllers.current.delete(controller)
      if (alive.current) setIsSending(false)
    }
  }, [isSending, accept, retryBlocked, respectThrottle, confirmedRuntime, confirmRuntime])

  const setRecentTopicEnabled = useCallback(async (value: boolean) => {
    if (preferenceWrite.current) return
    preferenceWrite.current = true; focusController.current?.abort()
    if (!value) setConsentOverride(false)
    setSavingPreference(true); setRequestedPreference(value); setPreferenceError('')
    const controller = new AbortController(); controllers.current.add(controller)
    try {
      // Revalidation started before this explicit choice must not overwrite its
      // newer preference response when the old GET eventually arrives.
      await queries.cancelQueries({ queryKey: [...root, 'preferences'], exact: true })
      await queries.cancelQueries({ queryKey: [...root, 'recent-topic'], exact: true })
      const cached = queries.getQueryData<ChatPreferences>([...root, 'preferences'])
      const previous = !preferenceNeedsRefresh.current && cached ? cached : await boundApi.current.preferences(controller.signal)
      preferenceNeedsRefresh.current = false
      const updated = await boundApi.current.setPreferences(value, previous.version, controller.signal)
      if (!alive.current || controller.signal.aborted) return
      queries.setQueryData([...root, 'preferences'], updated)
      setConsentOverride(null); setConsentUnconfirmed(false); setHiddenTopic(null)
      void queries.invalidateQueries({ queryKey: [...root, 'recent-topic'] })
    } catch (cause) {
      if (alive.current) setPreferenceError(controller.signal.aborted ? '设置结果尚未确认，请重新读取并重试。' : `设置尚未保存：${errorMessage(cause)}`)
      void queries.invalidateQueries({ queryKey: [...root, 'preferences'] })
    } finally {
      controllers.current.delete(controller); preferenceWrite.current = false
      if (alive.current) { setSavingPreference(false); setRequestedPreference(null) }
    }
  }, [queries, root])

  const dismissRecentTopic = useCallback(async (id: string) => {
    const item = topic.data
    if (!item || item.conversation_id !== id || preferenceWrite.current) return
    preferenceWrite.current = true; preferenceNeedsRefresh.current = true
    focusController.current?.abort(); setSavingPreference(true)
    setHiddenTopic(item.summary_version)
    const controller = new AbortController(); controllers.current.add(controller)
    let dismissalSaved = false
    try {
      await boundApi.current.dismiss(id, item.summary_version, controller.signal)
      dismissalSaved = true
      if (!alive.current || controller.signal.aborted) return
      // Dismissal updates the server preference version too. Keep other local
      // preference commands disabled until its new version is authoritative.
      await queries.cancelQueries({ queryKey: [...root, 'preferences'], exact: true })
      await queries.fetchQuery({ queryKey: [...root, 'preferences'], staleTime: 0, retry: false,
        queryFn: () => boundApi.current.preferences(controller.signal) })
      if (!controller.signal.aborted) preferenceNeedsRefresh.current = false
    }
    catch (cause) {
      if (alive.current && !controller.signal.aborted) setActionError(`${dismissalSaved
        ? '话题已隐藏，授权版本尚未同步' : '隐藏尚未保存'}：${errorMessage(cause)}`)
    } finally {
      controllers.current.delete(controller); preferenceWrite.current = false
      if (alive.current) { setSavingPreference(false); refresh() }
    }
  }, [topic.data, refresh, queries, root])

  const orderedMessages = useMemo(() => {
    const byId = new Map<string, StoredMessage>()
    for (const page of messages.data?.pages ?? []) for (const message of page.items) {
      if (message.session_id === selected) byId.set(message.id, message)
    }
    for (const message of Object.values(live)) if (message.session_id === selected) byId.set(message.id, message)
    return [...byId.values()].sort((a, b) => a.sequence - b.sequence)
  }, [messages.data, live, selected])
  const sessions = useMemo(() => {
    const byId = new Map<string, StoredSession>()
    for (const page of history.data?.pages ?? []) for (const item of page.items) if (!byId.has(item.id)) byId.set(item.id, item)
    if (detail.data && detail.data.id === selected) {
      const listed = byId.get(detail.data.id)
      if (!listed || detail.data.version >= listed.version) byId.set(detail.data.id, detail.data)
    }
    return [...byId.values()].filter((item) => !removed.has(item.id)).map((item): ChatSession => ({
      id: item.id, ownerScopeId: owner, title: item.title, source: 'server', version: item.version,
      lastMessageAt: item.last_message_at ?? item.created_at,
      messages: item.id === selected ? orderedMessages.map((message) => viewMessage(message,
        message.generation_id === generation?.id ? generation : undefined,
        message.generation_id === generation?.id ? finishReason : null)) : [],
    }))
  }, [history.data, detail.data, selected, removed, owner, orderedMessages, generation, finishReason])
  const recentTopic: RecentConversationSummary | null = enabled && topic.data && !removed.has(topic.data.conversation_id)
    && hiddenTopic !== topic.data.summary_version ? {
      conversationId: topic.data.conversation_id, ownerScopeId: owner, title: topic.data.title,
      summary: topic.data.summary, lastMessageAt: topic.data.last_message_at, followUpText: topic.data.follow_up_text,
      dismissed: false, source: 'message-excerpt', sourceMessageIds: topic.data.source_message_ids, summaryVersion: topic.data.summary_version,
    } : null
  const running = currentGeneration && !isTerminal(currentGeneration.state) ? selected ?? null : null
  const readError = detail.error ?? messages.error
  return <ChatContext.Provider value={{ sessions, generatingSessionId: running, sendMessage, stopGeneration,
    deleteSession: removeSession, recentTopicEnabled: enabled, setRecentTopicEnabled, recentTopic, dismissRecentTopic,
    previewIdentityId: 'preview-a', switchPreviewIdentity: () => {}, demoHistoryLoaded: false, loadDemoHistory: () => {},
    privateChat: {
      runtime: confirmedRuntime, runtimeLoading: runtime.isPending,
      runtimeError: runtime.error ? errorMessage(runtime.error) : '',
      reloadRuntime: () => { void runtime.refetch() },
      selectedSessionId: selected, selectSession,
      loading: !!selected && (detail.isPending || messages.isPending), historyLoading: history.isPending,
      historyError: history.error ? errorMessage(history.error) : '',
      error: actionError || (readError ? errorMessage(readError) : '') || (topic.error ? errorMessage(topic.error) : ''),
      readError: readError ? errorMessage(readError) : '', retryRead: () => {
        if (!selected) return
        void queries.invalidateQueries({ queryKey: [...root, 'session', selected] })
        void queries.invalidateQueries({ queryKey: [...root, 'messages', selected] })
      },
      sending: isSending, retryBlocked, cancelling: cancelling || currentGeneration?.state === 'cancel_requested'
        || (cancelRequestedId !== null && cancelRequestedId === currentGeneration?.id), connectionState,
      hasMoreSessions: history.hasNextPage, hasMoreMessages: messages.hasNextPage,
      loadingMoreMessages: messages.isFetchingNextPage,
      loadMoreSessions: () => { void history.fetchNextPage().catch(() => undefined) },
      loadMoreMessages: () => { void messages.fetchNextPage().catch(() => undefined) }, prepareRename, rename,
      hasPendingSend,
      retryPendingSend: () => pending.current ? executeSend(pending.current) : Promise.reject(new Error('没有待确认的发送请求。')),
      retryGeneration, reconnect: () => { setActionError(''); setReconnectVersion((value) => value + 1) },
      refreshHistory: refresh, preferencesLoading: !petId && preferences.isPending, preferencesSaving: savingPreference, preferencesRequested: requestedPreference,
      preferencesError: preferenceError || (preferences.error ? errorMessage(preferences.error) : ''),
    } }}>{children}</ChatContext.Provider>
}
