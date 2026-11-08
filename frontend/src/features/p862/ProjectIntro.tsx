import { BookOpen, Gift, Heart, Info, Sparkles, UsersRound, WandSparkles } from 'lucide-react'
import { brand } from '../../lib/brand'
import { Landscape } from './landscape'

const features = [
  [Sparkles, '八种角色 · 多实例养成'], [Heart, '自主活动 · 情绪与需求'],
  [UsersRound, '伙伴关系 · 结伴与小团体'], [WandSparkles, '轻松冲突 · 和解与成长'],
  [BookOpen, '事件记忆 · 真实共同经历'], [Gift, '免费互动 · 安慰与投喂'],
] as const

export function ProjectIntro() {
  return <aside className="p862-intro" aria-label="项目简介">
    <h2><Info size={25} />项目简介</h2>
    <div className="p862-intro-scene"><Landscape /></div>
    <h3>{brand.name}</h3>
    <p>一款让多只 AI 宠物在桌面上自由生活、互动和成长的陪伴应用。</p>
    <ul>{features.map(([Icon, text]) => <li key={text}><span><Icon size={21} /></span>{text}</li>)}</ul>
    <div className="p862-intro-footer"><Landscape trees /></div>
  </aside>
}
