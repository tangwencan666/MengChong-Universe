import type { SocietyEnvelope, SocialAction, SocialSettings } from '../p86/society'
import type { CompanionContext, ContextChange } from '../p863/context'
export interface DesktopPet {
  pet_id: string
  name: string
  role_type: string
  tint: string
  state: string
  direction: string
  hidden: boolean
  chat_open: boolean
}

export interface DesktopState {
  authenticated: boolean
  owner_id: string | null
  pets: DesktopPet[]
}

export interface DesktopBridge {
  readonly version: string
  layout?(): Promise<DesktopLayout>
  recallAll?(expectedOwner: string): Promise<DesktopLayout>
  restoreCombination?(expectedOwner: string): Promise<DesktopLayout>
  activity?(id: string, signal: DesktopActivitySignal): Promise<null>
  list(): Promise<DesktopPet[]>
  release(id: string): Promise<DesktopPet | null>
  hide(id: string): Promise<DesktopPet | null>
  show(id: string): Promise<DesktopPet | null>
  recall(id: string): Promise<DesktopPet | null>
  openChat(id: string): Promise<DesktopPet | null>
  syncSession(): Promise<Omit<DesktopState, 'pets'> & { changed: boolean }>
  onChange(callback: (state: DesktopState) => void): () => void
  society?(owner: string): Promise<SocietyEnvelope>
  socialAction?(owner: string, id: string, action: SocialAction, key: string, version: number): Promise<SocietyEnvelope>
  socialSettings?(owner: string, patch: Partial<SocialSettings>): Promise<SocietyEnvelope>
  deleteSocialEvent?(owner: string, id: string): Promise<SocietyEnvelope>
  onSociety?(callback: (value: SocietyEnvelope) => void): () => void
  companionContext?(id: string, session: string | null, mode: 'peek' | 'recount'): Promise<CompanionContext>
  onCompanionContext?(callback: (value: ContextChange) => void): () => void
}

export interface DesktopLayout {
  owner_id: string | null
  current: string[]
  previous_count: number
  restore_available: boolean
  reduced_motion: boolean
  metrics_available: boolean
  max_visible: number
  skipped_count: number
}

export interface DesktopActivitySignal {
  generation_id: string
  session_id: string
  sequence: number
  state: 'queued' | 'running' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled'
  has_output: boolean
}

declare global {
  interface Window { readonly weibiyeDesktop?: DesktopBridge }
}

export const desktopBridge = () => window.weibiyeDesktop
