import { Link } from 'react-router'
import { ArrowUpRight, Clock3, MessageCircle } from 'lucide-react'
import { useChat } from './context'

export function RecentTopicCard() {
  const { recentTopic: topic, dismissRecentTopic, stopGeneration, privateChat } = useChat()
  if (!topic) return null
  const time = new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(topic.lastMessageAt))
  return <section className="recent-topic-card" aria-label="最近话题" data-conversation-id={topic.conversationId}>
    <div className="recent-topic-meta"><span><MessageCircle size={13} />上次的话题</span><span>{privateChat ? '已保存的消息摘录' : topic.source === 'mock' ? 'Mock 会话 · 演示时间' : '本页消息摘录'}</span></div>
    <h2>接着上次的话题聊聊？</h2>
    <div className="recent-topic-time"><Clock3 size={11} /><span>上次聊天：</span><time dateTime={topic.lastMessageAt}>{time}</time></div>
    <p className="recent-topic-summary" title={topic.summary}>{topic.summary}</p>
    <p className="recent-topic-follow-up">{topic.followUpText}</p>
    <div className="recent-topic-actions"><Link className="recent-topic-continue" to={`/chat/${encodeURIComponent(topic.conversationId)}`} onClick={() => { if (!privateChat) void stopGeneration() }}>继续聊聊<ArrowUpRight size={13} /></Link><button onClick={() => void dismissRecentTopic(topic.conversationId)}>暂时不看</button></div>
  </section>
}
