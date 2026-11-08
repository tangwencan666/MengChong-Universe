import axios from 'axios'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/context'
import { errorMessage } from '../../lib/api'
import { createMemoryApi } from './api'
import { MemoryContext } from './context'
import { candidateSelection, loadMemorySnapshot, MEMORY_CONSENT, MemoryIntentKeys, MemorySnapshotChanged, normalizeMemoryContent } from './contracts'
import type { MemoryCandidate, MemoryContent, MemoryContextValue, MemoryItem, MemoryPreferences, MemoryPreview, SourceInput } from './types'

interface Session {
  controller: AbortController
  preferences: MemoryPreferences | null
  invalidations: number
  readController: AbortController | null
  sync: Promise<void> | null
  pending: boolean
  intents: MemoryIntentKeys
  previews: WeakMap<MemoryPreview, number>
  channel: BroadcastChannel | null
}
const stale = () => new axios.CanceledError('账户或记忆授权已更新，本次结果已丢弃。')
const samePolicy = (a: MemoryPreferences, b: MemoryPreferences) => a.privacy_epoch === b.privacy_epoch && a.revision === b.revision && a.version === b.version

export function MemoryProvider({ children, petId }: { children: ReactNode; petId?: string }) {
  const port = useRef(createMemoryApi(petId))
  const { user, scopeVersion } = useAuth()
  const owner = user?.id
  const active = useRef<Session | null>(null)
  const [preferences, setPreferences] = useState<MemoryPreferences | null>(null)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [loading, setLoading] = useState(Boolean(owner))
  const [syncing, setSyncing] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [unavailable, setUnavailable] = useState(false)

  const live = useCallback((session: Session) => active.current === session && !session.controller.signal.aborted, [])
  const requireLive = useCallback((session: Session, revision?: number) => {
    if (!live(session) || (revision !== undefined && session.invalidations !== revision)) throw stale()
  }, [live])
  const invalidate = useCallback((session: Session, keepRead?: AbortController, clearIntents = false) => {
    if (!live(session)) return
    session.invalidations += 1
    session.previews = new WeakMap()
    if (clearIntents) session.intents.clear()
    session.preferences = null
    if (session.readController !== keepRead) session.readController?.abort()
    setItems([]); setPreferences(null)
    window.dispatchEvent(new Event('weibiye:memory-invalidated'))
  }, [live])

  const synchronize = useCallback(async (session: Session, force = false): Promise<void> => {
    if (!live(session)) return
    if (session.sync) return session.sync
    const controller = new AbortController()
    session.readController = controller
    const stop = () => controller.abort()
    session.controller.signal.addEventListener('abort', stop, { once: true })
    const job = async () => {
      setSyncing(true)
      if (!session.preferences) setLoading(true)
      let revision = session.invalidations
      try {
        const head = await port.current.preferences(controller.signal)
        requireLive(session, revision)
        if (!force && session.preferences && samePolicy(session.preferences, head)) return
        if (session.preferences && !samePolicy(session.preferences, head)) {
          invalidate(session, controller, true)
          revision = session.invalidations
        }
        const snapshot = await loadMemorySnapshot(port.current, controller.signal, head)
        requireLive(session, revision)
        session.preferences = snapshot.preferences
        setPreferences(snapshot.preferences); setItems(snapshot.items)
        setUnavailable(false); setError('')
      } catch (cause) {
        if (!live(session) || axios.isCancel(cause) || controller.signal.aborted) return
        invalidate(session, controller)
        setUnavailable(axios.isAxiosError(cause) && cause.response?.status === 503)
        setError(errorMessage(cause))
      } finally {
        session.controller.signal.removeEventListener('abort', stop)
        if (session.readController === controller) session.readController = null
        if (live(session)) { setLoading(false); setSyncing(false) }
      }
    }
    const promise = job().finally(() => { if (session.sync === promise) session.sync = null })
    session.sync = promise
    return promise
  }, [invalidate, live, requireLive])

  useEffect(() => {
    // Every effect instance owns a distinct session. StrictMode cleanup cannot
    // revive old work when its replacement starts, even for the same account.
    const session: Session = { controller: new AbortController(), preferences: null, invalidations: 0,
      readController: null, sync: null, pending: false, intents: new MemoryIntentKeys(), previews: new WeakMap(), channel: null }
    active.current = session
    const refreshIfVisible = () => {
      if (document.visibilityState !== 'hidden' && owner) void synchronize(session)
    }
    if (owner) void Promise.resolve().then(() => synchronize(session))
    else void Promise.resolve().then(() => {
      if (live(session)) { setLoading(false); setPreferences(null); setItems([]) }
    })
    window.addEventListener('focus', refreshIfVisible)
    window.addEventListener('online', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    const timer = window.setInterval(refreshIfVisible, 30_000)
    if (owner && 'BroadcastChannel' in window) {
      session.channel = new BroadcastChannel(petId ? `weibiye-memory:${owner}:${petId}` : 'weibiye-memory')
      session.channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data !== 'invalidated' || !live(session)) return
        invalidate(session, undefined, true)
        setNotice('其他页面更新了记忆设置，正在重新读取。')
        void session.sync?.finally(() => synchronize(session, true))
        if (!session.sync) void synchronize(session, true)
      }
    }
    return () => {
      session.controller.abort(); session.readController?.abort(); session.intents.clear()
      session.previews = new WeakMap(); session.channel?.close()
      if (active.current === session) active.current = null
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshIfVisible)
      window.removeEventListener('online', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [owner, scopeVersion, synchronize, invalidate, live, petId])

  const sessionFor = useCallback(async () => {
    // Descendant passive effects may run before this provider's setup.
    await Promise.resolve()
    const session = active.current
    if (!session || !owner) throw stale()
    requireLive(session)
    return session
  }, [owner, requireLive])

  const mutation = useCallback(async <T,>(identity: string, payload: unknown,
    send: (payload: unknown, key: string, signal: AbortSignal) => Promise<T>, success: string, privacyChange = false): Promise<T> => {
    const session = await sessionFor()
    if (session.pending) throw new Error('上一项操作仍在确认，请稍后再试。')
    const intent = session.intents.obtain(identity, payload)
    const revision = session.invalidations
    session.pending = true; setPending(true); setError(''); setNotice('')
    try {
      const result = await send(intent.payload, intent.key, session.controller.signal)
      requireLive(session, revision)
      session.intents.complete(identity)
      invalidate(session, undefined, privacyChange)
      session.channel?.postMessage('invalidated')
      // Any old metadata read is aborted by invalidate. Wait for it to release
      // the synchronization slot before reading the committed result.
      await session.sync
      requireLive(session)
      await synchronize(session, true)
      requireLive(session)
      setNotice(success + (session.preferences ? '' : ' 最新状态暂未同步，请重新读取。'))
      return result
    } catch (cause) {
      if (!live(session)) throw stale()
      if (!axios.isCancel(cause)) {
        const status = axios.isAxiosError(cause) ? cause.response?.status : undefined
        if ((status && [400, 401, 403, 404, 409, 410, 422].includes(status)) || cause instanceof MemorySnapshotChanged) session.intents.complete(identity)
        invalidate(session, undefined, !!status && [401, 409, 410].includes(status))
        setError(errorMessage(cause) + (!status || status >= 500 ? ' 结果尚未确认；重新读取后，相同内容的重试会沿用原请求。' : ' 请重新读取当前状态后再操作。'))
      }
      throw cause
    } finally {
      session.pending = false
      if (live(session)) setPending(false)
    }
  }, [invalidate, live, requireLive, sessionFor, synchronize])

  const preferenceFor = useCallback(async (enabled = false) => {
    const session = await sessionFor()
    if (!session.preferences) throw new Error('请先重新读取记忆状态。')
    if (enabled && !session.preferences.long_term_memory_enabled) throw new Error('长期记忆尚未开启，请先阅读授权说明。')
    return { session, pref: session.preferences }
  }, [sessionFor])

  const refresh = useCallback(async () => { const session = await sessionFor(); await session.sync; await synchronize(session, true) }, [sessionFor, synchronize])
  const setEnabled = useCallback(async (enabled: boolean) => {
    const { pref } = await preferenceFor()
    const payload = { long_term_memory_enabled: enabled, expected_version: pref.version, ...(enabled ? { consent: MEMORY_CONSENT } : {}) }
    await mutation(`preferences:${enabled}`, payload, async (body, key, signal) => {
      const result = await port.current.setPreferences(body, key, signal)
      if (result.long_term_memory_enabled !== enabled) throw new MemorySnapshotChanged()
      return result
    }, enabled ? '长期记忆已开启，只有你逐条确认的内容才会保存。' : '长期记忆授权已关闭；最近话题设置保持不变。', !enabled)
  }, [mutation, preferenceFor])
  const create = useCallback(async (content: MemoryContent, source: SourceInput = { kind: 'manual' }) => {
    const normalized = normalizeMemoryContent(content), { pref } = await preferenceFor(true)
    const payload = { ...normalized, source, expected_preferences_version: pref.version, consent: MEMORY_CONSENT }
    return mutation(`create:${JSON.stringify({ ...normalized, source })}`, payload, port.current.create, '这条记忆已由你确认保存。')
  }, [mutation, preferenceFor])
  const edit = useCallback(async (item: MemoryItem, content: MemoryContent) => {
    const normalized = normalizeMemoryContent(content), { pref } = await preferenceFor(true)
    const payload = { ...normalized, expected_preferences_version: pref.version, expected_version: item.version, consent: MEMORY_CONSENT }
    return mutation(`edit:${item.id}:${item.version}:${JSON.stringify(normalized)}`, payload,
      (body, key, signal) => port.current.edit(item.id, body, key, signal), '记忆已更新，后续回复使用新的内容。', true)
  }, [mutation, preferenceFor])
  const remove = useCallback(async (item: MemoryItem) => {
    await preferenceFor()
    await mutation(`remove:${item.id}:${item.version}`, { expected_version: item.version },
      (body, key, signal) => port.current.remove(item.id, body, key, signal), '这条记忆已删除，不再用于后续回复。', true)
  }, [mutation, preferenceFor])
  const revoke = useCallback(async (item: MemoryItem) => {
    await preferenceFor()
    await mutation(`revoke:${item.id}:${item.version}`, { expected_version: item.version },
      (body, key, signal) => port.current.revoke(item.id, body, key, signal), '这条记忆已停止使用，仍可查看或删除。', true)
  }, [mutation, preferenceFor])
  const clear = useCallback(async () => {
    const { pref } = await preferenceFor()
    await mutation(`clear:${pref.revision}`, { expected_revision: pref.revision, confirmed: true }, port.current.clear, '长期记忆已清空，聊天记录和最近话题设置没有删除。', true)
  }, [mutation, preferenceFor])
  const preview = useCallback(async (sessionId: string, messageIds: string[]) => {
    const { session, pref } = await preferenceFor(true), revision = session.invalidations
    const result = await port.current.preview(sessionId, messageIds, pref.version, session.controller.signal)
    requireLive(session, revision)
    session.previews.set(result, revision)
    return result
  }, [preferenceFor, requireLive])
  const confirmCandidate = useCallback(async (shown: MemoryPreview, candidate: MemoryCandidate, content: MemoryContent) => {
    const { session, pref } = await preferenceFor(true), revision = session.invalidations
    if (session.previews.get(shown) !== revision) throw new Error('预览或授权已更新，请重新选择消息。')
    const selected = candidateSelection(shown, candidate), normalized = normalizeMemoryContent(content)
    const identity = `candidate:${JSON.stringify({ ...selected, ...normalized })}`
    const previous = session.intents.peek(identity)
    if (previous) return mutation(identity, previous.payload, port.current.create, '这条候选记忆已由你确认保存。')
    // A fresh receipt permits sequential, explicit confirmations after the prior
    // save advanced epoch. It does not authorize adding unselected messages.
    const fresh = await port.current.preview(selected.sessionId, selected.messageIds, pref.version, session.controller.signal)
    requireLive(session, revision)
    const payload = { ...normalized, expected_preferences_version: pref.version, consent: MEMORY_CONSENT,
      source: { kind: 'chat_message', session_id: selected.sessionId, message_ids: selected.messageIds, preview_token: fresh.preview_token } }
    return mutation(identity, payload, port.current.create, '这条候选记忆已由你确认保存。')
  }, [mutation, preferenceFor, requireLive])
  const exportMemories = useCallback(async () => {
    const { session, pref } = await preferenceFor(), revision = session.invalidations
    const result = await port.current.export(session.controller.signal)
    requireLive(session, revision)
    const head = await port.current.preferences(session.controller.signal)
    requireLive(session, revision)
    if (!samePolicy(pref, head) || result.snapshot_revision !== head.revision) {
      invalidate(session); throw new MemorySnapshotChanged()
    }
    return result
  }, [invalidate, preferenceFor, requireLive])
  const generationRefs = useCallback(async (sessionId: string, generationId: string) => {
    const session = await sessionFor(), revision = session.invalidations
    const result = await port.current.generationRefs(sessionId, generationId, session.controller.signal)
    requireLive(session, revision)
    return result
  }, [requireLive, sessionFor])

  const value = useMemo<MemoryContextValue>(() => ({ preferences, items, loading, syncing, pending, error, notice, unavailable,
    refresh, setEnabled, create, edit, remove, revoke, clear, exportMemories, preview, confirmCandidate, generationRefs }),
  [preferences, items, loading, syncing, pending, error, notice, unavailable, refresh, setEnabled, create, edit, remove, revoke, clear, exportMemories, preview, confirmCandidate, generationRefs])
  return <MemoryContext.Provider value={value}>{children}</MemoryContext.Provider>
}
