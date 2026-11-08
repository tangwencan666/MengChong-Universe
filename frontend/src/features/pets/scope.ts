/** An absent scope means legacy only, never all pets. Invalid IDs never fall back. */
export function assertPetId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('宠物身份无效。')
  return id.toLowerCase()
}
export function petScope(pathname: string): string | undefined {
  const match = /^\/pets\/([^/]+)(?:\/|$)/.exec(pathname)
  return match ? assertPetId(decodeURIComponent(match[1])) : undefined
}
export function chatHome(petId?: string) { return petId ? `/pets/${assertPetId(petId)}` : '/' }
export function chatLink(sessionId: string, petId?: string) { return `${petId ? chatHome(petId) : ''}/chat/${encodeURIComponent(sessionId)}` }
export function memoryLink(petId?: string) { return petId ? `${chatHome(petId)}/memory` : '/memory' }
export function assertScope(value: unknown, petId?: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务响应无法确认，已停止展示。')
  const actual = (value as { pet_id?: unknown }).pet_id
  if (petId ? actual !== petId : actual !== undefined && actual !== null) throw new Error('服务响应与当前宠物不匹配，已停止展示。')
}
