import { createContext, useContext } from 'react'
import type { ChatContextValue } from './types'

export const ChatContext = createContext<ChatContextValue | null>(null)

export function useChat() {
  const value = useContext(ChatContext)
  if (!value) throw new Error('ChatProvider is required')
  return value
}
