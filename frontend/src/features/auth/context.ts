import { createContext, useContext } from 'react'

export interface AuthUser {
  id: string
  email: string
  display_name: string
  role: 'user' | 'moderator' | 'admin'
  status: 'active' | 'disabled'
  email_verified: boolean
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  notice: string
  scopeVersion: number
  login: (email: string, password: string) => Promise<void>
  logout: (all?: boolean) => Promise<void>
  refresh: () => Promise<void>
  invalidate: (message?: string) => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('AuthProvider is required')
  return value
}
