import { Link } from 'react-router'
import { ArrowLeft, BookHeart, FlaskConical, ShieldCheck } from 'lucide-react'
import { Button, Card, ErrorState, Loading } from '../components/ui'
import { useChat } from '../features/chat/context'
import type { PreviewIdentityId } from '../features/chat/types'

export function ConversationPreferencesPage() {
  const { recentTopicEnabled, setRecentTopicEnabled, demoHistoryLoaded, loadDemoHistory,
    previewIdentityId, switchPreviewIdentity, privateChat } = useChat()
  return <div className="conversation-preferences">
    <Link className="back-link" to="/"><ArrowLeft size={15} />返回聊天首页</Link>
    <div className="page-title"><div><span className="eyebrow">AT YOUR OWN PACE</span><h1>话题续聊设置<span className="title-dot">.</span></h1><p>要不要接着聊，由你决定。</p></div></div>
    <Card className="topic-preference-card"><div className="preference-heading"><ShieldCheck size={22} /><h2>最近话题</h2><span>{recentTopicEnabled ? privateChat ? '当前账户已允许' : '已允许 · 仅本页' : '已关闭 · 默认保护隐私'}</span></div>
      <p>{privateChat ? '允许后，首页可以展示当前账户已完成对话的消息摘录；关闭立即停止本页推荐，不会删除会话。' : '允许后，首页可以根据当前访客仍保留的会话，展示一张最近话题卡片。关闭只会停止推荐，不会删除会话。'}</p>
      {privateChat?.preferencesLoading && <Loading message="正在读取授权设置…" />}
      <label className="topic-consent-control"><input type="checkbox" checked={privateChat?.preferencesRequested ?? recentTopicEnabled} disabled={privateChat?.preferencesLoading || privateChat?.preferencesSaving} onChange={(event) => void setRecentTopicEnabled(event.target.checked)} /><span>{privateChat ? '允许当前账户历史话题推荐' : '允许本页历史话题推荐'}</span></label>
      {privateChat?.preferencesSaving && <p role="status">正在保存授权设置…</p>}
      {privateChat?.preferencesError && <ErrorState message={privateChat.preferencesError} />}
      <p className="preference-footnote">{privateChat ? '授权设置保存到当前账户；默认关闭。卡片只摘录已完成对话，不生成虚构经历，也不写长期记忆。' : '这是前端预览授权，仅在当前页面生效。刷新后会清空历史并默认关闭；登录后可使用账户授权设置。'}</p>
    </Card>
    <Card className="topic-memory-boundary"><BookHeart size={21} /><div><h2>最近话题与长期记忆分开</h2><p>话题卡片用于回到一段原始会话，不会把内容写入长期记忆。保存重要经历、个人目标或交流偏好，需要单独开启长期记忆并逐条确认。</p><Link to="/memory" className="text-link">查看记忆管理</Link></div></Card>
    {!privateChat && <Card className="topic-demo-tools"><div className="preference-heading"><FlaskConical size={20} /><h2>用虚构会话预览</h2><span className="demo-tag">Mock</span></div><p>示例来自本项目的虚构文案，不读取真实账户或其他人的聊天。加载历史不会自动开启推荐。</p>
      <div className="preview-identity-control"><label htmlFor="preview-identity">演示访客</label><select id="preview-identity" value={previewIdentityId} onChange={(event) => switchPreviewIdentity(event.target.value as PreviewIdentityId)}><option value="preview-a">演示访客 A</option><option value="preview-b">演示访客 B</option></select></div>
      <p className="preference-footnote">切换会清空当前页对话、授权和推荐，并中止正在生成的回复。此处不代表真实用户登录。</p>
      <Button variant="secondary" disabled={demoHistoryLoaded} onClick={loadDemoHistory}>{demoHistoryLoaded ? '已加载虚构历史' : '加载虚构历史'}</Button>
      {demoHistoryLoaded && <p className="demo-load-status" role="status">虚构历史已加入侧边栏。若愿意预览卡片，可勾选上方授权，再返回首页。</p>}
    </Card>}
  </div>
}
