import { Route, Routes, Link, Navigate, useLocation } from 'react-router'
import { AppLayout } from './components/layout'
import { Card, EmptyState } from './components/ui'
import { HomePage } from './pages/home'
import { CompanionPage } from './pages/companion'
import { CompanionsPage } from './pages/companions'
import { AuthProvider } from './features/auth/AuthProvider'
import { RequireAuth } from './features/auth/RequireAuth'
import { useAuth } from './features/auth/context'
import { AuthPage } from './pages/auth'
import { SessionsPage } from './pages/sessions'
import { RecoveryRequestPage, RecoveryTokenPage } from './pages/recovery'
import type { ReactNode } from 'react'
import { ChatProvider } from './features/chat/ChatProvider'
import { ConversationPreferencesPage } from './pages/conversation-preferences'
import { AdminPage, ProfilePage, WalletPage } from './pages/workspace'
import { MemoryPage } from './pages/memory'
import { MemoryProvider } from './features/memory/MemoryProvider'
import { petScope } from './features/pets/scope'
import { PetScopeProvider } from './features/pets/PetScopeProvider'
import { DesktopIdentitySync } from './features/desktop/DesktopIdentitySync'
import { BetaPage } from './pages/beta'
import { BetaUsage } from './features/beta/BetaUsage'
import { PetCatalogPage } from './pages/p84-catalog'

function UserScopedChat({ children }: { children: ReactNode }) {
  const { scopeVersion } = useAuth()
  const { pathname } = useLocation()
  let petId: string | undefined
  try { petId = petScope(pathname) } catch { return <Card><p>宠物身份无效。</p><Link to="/companions">返回我的宠物</Link></Card> }
  const scope = `${scopeVersion}:${petId ?? 'legacy'}`
  return <PetScopeProvider key={scope} petId={petId}><MemoryProvider petId={petId}><ChatProvider petId={petId}>{children}</ChatProvider></MemoryProvider></PetScopeProvider>
}

export function App() {
  return <AuthProvider><DesktopIdentitySync /><BetaUsage /><UserScopedChat><Routes><Route element={<AppLayout />}>
    <Route index element={<CompanionPage />} />
    <Route path="chat/:sessionId" element={<CompanionPage />} />
    <Route path="preferences/conversations" element={<ConversationPreferencesPage />} />
    <Route path="welcome" element={<HomePage />} />
    <Route path="companion" element={<Navigate to="/" replace />} />
    <Route element={<RequireAuth />}><Route path="companions" element={<CompanionsPage />} />
    <Route path="pets/:petId" element={<CompanionPage />} />
    <Route path="pets/:petId/chat/:sessionId" element={<CompanionPage />} />
    <Route path="pets/:petId/memory" element={<MemoryPage />} />
    <Route path="wallet" element={<WalletPage />} />
    <Route path="beta" element={<BetaPage />} />
    <Route path="pet-catalog" element={<PetCatalogPage />} />
    <Route path="memory" element={<MemoryPage />} />
    <Route path="me" element={<ProfilePage />} />
    <Route path="me/sessions" element={<SessionsPage />} /></Route>
    <Route path="login" element={<AuthPage key="login" />} />
    <Route path="register" element={<AuthPage key="register" register />} />
    <Route path="forgot-password" element={<RecoveryRequestPage key="forgot" />} />
    <Route path="resend-verification" element={<RecoveryRequestPage key="resend" verification />} />
    <Route path="verify-email" element={<RecoveryTokenPage key="verify" verification />} />
    <Route path="reset-password" element={<RecoveryTokenPage key="reset" />} />
    <Route element={<RequireAuth admin />}><Route path="admin" element={<AdminPage />} /></Route>
    <Route path="*" element={<Card><EmptyState title="这片小天地还没开垦" description="找不到这个页面，先回首页歇一歇吧。" action={<Link to="/" className="button button-primary">回到首页</Link>} /></Card>} />
  </Route></Routes></UserScopedChat></AuthProvider>
}
