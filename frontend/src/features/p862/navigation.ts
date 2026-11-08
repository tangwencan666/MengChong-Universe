export const petNavigation = [
  { to: '/companions', title: '我的宠物', icon: 'home' },
  { to: '/companions#desktop-interactions', title: '桌面互动', icon: 'chat' },
  { to: '/me#pet-social', title: '设置', icon: 'settings' },
] as const

export function navigationActive(to: string, pathname: string, hash: string) {
  const [path, fragment = ''] = to.split('#')
  return pathname === path && hash === (fragment ? `#${fragment}` : '')
}
