import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useAuth } from '../auth/context'
import { useDesktop } from '../p85/useDesktop'
import { instancesApi } from '../p85/api'
import { SocietyPanel } from '../p86/SocietyPanel'

export function PetSocialSettings() {
  const { user } = useAuth()
  return user ? <Settings key={user.id} owner={user.id} /> : null
}
function Settings({ owner }: { owner: string }) {
  const { bridge, pets } = useDesktop(owner)
  const names = useInfiniteQuery({ queryKey: ['p85-instances', owner, 'active'], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => instancesApi.list(owner, 'active', pageParam, signal), retry: false,
    getNextPageParam: page => page.has_more ? page.next_cursor ?? undefined : undefined })
  useEffect(() => {
    if (location.hash === '#pet-social') document.getElementById('pet-social')?.scrollIntoView({ block: 'start' })
  }, [])
  return <section id="pet-social" className="p863-social-settings"><h2>宠物互动、事件与隐私</h2><p>这里保留关系、免费互动记录和共同事件删除。私人聊天与授权记忆仍由各宠物独立管理。</p>
    <SocietyPanel owner={owner} bridge={bridge} names={names.data?.pages.flatMap(page => page.items) ?? []} visibleIds={pets.filter(p => !p.hidden).map(p => p.pet_id)} />
  </section>
}
