import { useState } from 'react'
import cat from '../../../../desktop/assets/cat.svg'
import dog from '../../../../desktop/assets/dog.svg'
import cloud from '../../../../desktop/assets/cloud.svg'
import maodie from '../../../../desktop/assets/p84-maodie.svg'
import hajimi from '../../../../desktop/assets/p84-hajimi.svg'
import { desktopBridge } from '../desktop/bridge'
import { appearanceFor, availableViews } from './appearances'

export function AppearancePreview({ species, name }: { species: string; name: string }) {
  const appearance = appearanceFor(species), [failed, setFailed] = useState(false)
  const local = appearance.kind === 'local-raster'
  const fallback = ({ moon: cat, doubao: dog, xiaoyun: cloud, maodie, hajimi } as Record<string, string>)[species] ?? cloud
  const actual = local && !!desktopBridge() && !failed
  return <div className="p85-appearance-preview">
    <img src={actual ? `/__assets/${appearance.front_asset}` : fallback} alt={`${name}外观预览`} width={128} height={128} loading="lazy" onError={() => setFailed(true)} />
    {local && <><small>{actual ? '本机验证素材 · 静态图轻量动作' : '本地原图不可用，显示占位标识'}</small><small>可用运行视角：{availableViews(species).join('、')}</small><small>授权未确认，仅限本地验证</small></>}
  </div>
}
