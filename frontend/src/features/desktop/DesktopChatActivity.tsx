import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import { useChat } from '../chat/context'
import { desktopBridge } from './bridge'
import { desktopActivitySignal } from './activity'

// Presentation-only subscriber. It cannot start, cancel or retry a generation.
export function DesktopChatActivity() {
  const chat = useChat()
  const { pathname } = useLocation()
  const match = /^\/pets\/([a-f0-9-]{36})\/chat\/([a-f0-9-]{36})$/i.exec(pathname)
  const petId = match?.[1]
  const routeSessionId = match?.[2]
  const sessionId = chat.privateChat?.selectedSessionId
  const session = chat.sessions.find(item => item.id === sessionId)
  const message = session?.messages.filter(item => item.role === 'assistant' && item.generationId).at(-1)
  const generationId = message?.generationId
  const status = message?.status
  const hasOutput = Boolean(message?.content)
  const progress = useRef({ generationId: '', revision: 0 })
  useEffect(() => {
    if (!petId || !sessionId || routeSessionId !== sessionId || !generationId || !status) return
    const bridge = desktopBridge()
    if (!bridge?.activity) return
    if (progress.current.generationId !== generationId) progress.current = { generationId, revision: 0 }
    // This is a local presentation revision, not an authoritative SSE event ID.
    const signal = desktopActivitySignal({ generationId, status, hasOutput }, sessionId, ++progress.current.revision)
    if (signal) void bridge.activity(petId, signal).catch(() => {})
  }, [petId, sessionId, routeSessionId, generationId, status, hasOutput])
  return null
}
