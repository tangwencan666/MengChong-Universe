import { useState } from 'react'
import cat from '../../../../desktop/assets/cat.svg'
import dog from '../../../../desktop/assets/dog.svg'
import cloud from '../../../../desktop/assets/cloud.svg'
import maodie from '../../../../desktop/assets/p84-maodie.svg'
import hajimi from '../../../../desktop/assets/p84-hajimi.svg'
import { desktopBridge } from '../desktop/bridge'
import { appearanceFor } from '../p85/appearances'

export function PetPortrait({ species, appearance, name }: { species?: string; appearance?: string; name: string }) {
  const [failed, setFailed] = useState(false)
  const definition = species ? appearanceFor(species, appearance) : null
  if (!definition) return <span className="p862-pet-portrait" role="img" aria-label={`${name}外观资料尚未读取`} />
  const local = definition?.kind === 'local-raster' && desktopBridge() && !failed
  const fallback = ({ moon: cat, doubao: dog, xiaoyun: cloud, maodie, hajimi } as Record<string, string>)[species ?? ''] ?? cloud
  return <img className="p862-pet-portrait" src={local ? `/__assets/${definition.front_asset}` : fallback}
    alt={`${name}外观`} title={definition.kind === 'local-raster' && !local ? '本地原图不可用，显示占位标识；已保存外观不变' : undefined} width={120} height={112} loading="lazy" onError={() => setFailed(true)} />
}
