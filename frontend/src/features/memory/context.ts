import { createContext, useContext } from 'react'
import type { MemoryContextValue } from './types'

export const MemoryContext = createContext<MemoryContextValue | null>(null)

export function useMemory() {
  const context = useContext(MemoryContext)
  if (!context) throw new Error('MemoryProvider is required')
  return context
}
