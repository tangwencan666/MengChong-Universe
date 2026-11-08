import { Link } from 'react-router'
import { ArrowRight, ArrowUpRight, BookHeart, Gamepad2, MessageCircle, Monitor, ShieldCheck, Sparkles, Swords } from 'lucide-react'

const characters = [
  { id: 'niwa', name: '奶娃', role: '快乐，是我的必杀技', tone: 'peach' },
  { id: 'daodun', name: '刀盾', role: '小小身影，稳稳守护', tone: 'blue' },
  { id: 'whale', name: '鲸鱼娘', role: '把星光，带到你身旁', tone: 'lilac' },
]

export function HomePage() {
  return <div className="pet-universe">
    <div className="universe-topline"><span><i /> THE LITTLE PET UNIVERSE</span><span>陪伴有温度，乱斗有态度。</span></div>
    <section className="universe-hero">
      <div className="universe-copy"><span className="universe-eyebrow"><Sparkles size={14} /> 一群小伙伴，两种快乐</span>
        <h1>今天，想被陪伴。<br />还是<span>痛快玩一场？</span></h1>
        <p>让有个性的小伙伴住进桌面，也走上竞技场。<br />认真听你说话，陪你过招，把普通的一天变得有趣。</p>
        <div className="universe-actions"><Link to="/companions" className="universe-primary">遇见我的宠物 <ArrowRight size={17} /></Link><a href="#two-worlds" className="universe-secondary">探索两个世界 <ArrowUpRight size={16} /></a></div>
        <div className="universe-caption"><span><Monitor size={14} /> Windows 桌面伙伴</span><span><Swords size={14} /> 三角色轻格斗</span></div>
      </div>
      <div className="universe-art" aria-label="奶娃、刀盾与鲸鱼娘的角色展示">
        <div className="universe-orbit" /><span className="universe-sticker sticker-top">LET’S HANG OUT ✦</span><span className="universe-star star-one">✦</span><span className="universe-star star-two">✧</span>
        {characters.map((character, index) => <div key={character.id} className={`universe-pet pet-${index}`}><div className={`pet-halo ${character.tone}`} /><img src={`/showcase/${character.id}.png`} alt={character.name} /><span>{character.name}</span></div>)}
        <span className="universe-sticker sticker-bottom"><span /> 小小伙伴，随时在场</span>
      </div>
    </section>
    <section className="universe-worlds" id="two-worlds" aria-labelledby="worlds-heading">
      <div className="universe-section-heading"><div><span className="universe-eyebrow">PICK YOUR MOOD</span><h2 id="worlds-heading">同一个小宇宙，不一样的打开方式。</h2></div><span>01 / 陪伴与冒险</span></div>
      <div className="universe-world-grid">
        <article className="universe-world world-companion"><div className="world-top"><span className="world-icon"><MessageCircle size={23} /></span><span className="world-label">DESKTOP COMPANION</span><span className="world-number">01</span></div><h3>萌宠溜达<span>把陪伴，留在桌面上。</span></h3><p>独立身份、不同人格，聊天与日常互动各有自己的小天地。你决定哪些事情值得记住。</p><div className="world-tags"><span>多宠物桌面</span><span>流式聊天</span><span>自主授权记忆</span></div><Link to="/companions" className="world-link">去认识你的伙伴 <ArrowUpRight size={20} /></Link></article>
        <article className="universe-world world-brawl"><div className="world-top"><span className="world-icon"><Gamepad2 size={23} /></span><span className="world-label">A LITTLE FRIENDLY CHAOS</span><span className="world-number">02</span></div><h3>萌宠乱斗<span>可爱归可爱，出招不客气。</span></h3><p>奶娃、刀盾、鲸鱼娘，三种专属技能。练习走位、抓住破绽，和电脑或本机另一位玩家切磋。</p><div className="world-tags"><span>三角色技能</span><span>人机对战</span><span>本机双客户端</span></div><a href="https://github.com/tangwencan666/MengChong-Universe/tree/main/games/pet-brawl" target="_blank" rel="noreferrer" className="world-link">查看乱斗启动指南 <ArrowUpRight size={20} /></a></article>
      </div>
    </section>
    <section className="universe-principles" aria-label="陪伴的约定"><div><ShieldCheck size={21} /><h3>有边界，才安心</h3><p>记忆默认关闭，保存前由你逐条确认。</p></div><div><BookHeart size={21} /><h3>每只伙伴，都独立</h3><p>身份、聊天与授权记忆按宠物区分。</p></div><div><Sparkles size={21} /><h3>小步成长，认真兑现</h3><p>多宠物 AI 桌面陪伴软件，当前提供 Windows 桌面本地预览，尚未公开发行。真实模型默认关闭，长期记忆真实注入仍在验证中。</p></div></section>
    <div className="universe-endnote"><span>萌宠乱斗 & 萌宠溜达</span><span>MAKE A LITTLE ROOM FOR JOY. ✦</span></div>
  </div>
}
