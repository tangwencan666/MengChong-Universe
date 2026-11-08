import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { useAuth } from '../auth/context'
import { Card, ErrorState, Loading } from '../../components/ui'
import { errorMessage } from '../../lib/api'
import { petsApi } from './api'
import { PetContext } from './context'

export function PetScopeProvider({ petId, children }: { petId?: string; children: ReactNode }) {
  const { user, scopeVersion, loading } = useAuth()
  const queries = useQueryClient()
  const key = ['pet-detail', user?.id, scopeVersion, petId]
  const detail = useQuery({ queryKey: key, enabled: !!petId && !!user && !loading,
    queryFn: ({ signal }) => petsApi.detail(petId!, signal), retry: false })
  useEffect(() => {
    if (!petId) return
    const scope = ['pet-detail', user?.id, scopeVersion, petId]
    return () => { void queries.cancelQueries({ queryKey: scope }); queries.removeQueries({ queryKey: scope }) }
  }, [petId, user?.id, scopeVersion, queries])
  if (petId && user && detail.isPending) return <Loading message="正在确认宠物身份…" />
  if (petId && user && detail.isError) return <Card><ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} /><Link to="/companions">返回我的宠物</Link></Card>
  return <PetContext.Provider value={{ petId, pet: detail.data }}>{children}</PetContext.Provider>
}
