import type { ChatSession, RecentConversationSummary } from './types'

export function buildRecentTopic(
  session: ChatSession, dismissed: boolean, seeds: RecentConversationSummary[],
): RecentConversationSummary | null {
  const latestUserMessage = [...session.messages].reverse().find((message) => message.role === 'user' && message.content.trim())
  if (!latestUserMessage || !Number.isFinite(Date.parse(session.lastMessageAt))) return null
  const seed = seeds.find((item) => item.conversationId === session.id
    && item.ownerScopeId === session.ownerScopeId && item.lastMessageAt === session.lastMessageAt
    && item.sourceMessageIds.includes(latestUserMessage.id))
  if (seed) return { ...seed, dismissed }
  // An exact, bounded excerpt is honest about what exists. No model, inference,
  // sentiment analysis, or invented account of the user's day is used here.
  const excerpt = latestUserMessage.content.trim().replace(/\s+/g, ' ').slice(0, 80)
  return {
    conversationId: session.id, ownerScopeId: session.ownerScopeId, title: session.title,
    summary: `${excerpt}${latestUserMessage.content.trim().replace(/\s+/g, ' ').length > 80 ? '…' : ''}`,
    lastMessageAt: session.lastMessageAt,
    followUpText: '如果你愿意，我们可以从上次的这段话接着聊。',
    dismissed, source: session.source === 'demo' ? 'mock' : 'message-excerpt',
    sourceMessageIds: [latestUserMessage.id],
  }
}

export function selectRecentTopic(
  summaries: RecentConversationSummary[], conversations: ChatSession[], ownerScopeId: string,
): RecentConversationSummary | null {
  const valid = summaries.filter((summary) => {
    const conversation = conversations.find((item) => item.id === summary.conversationId
      && item.ownerScopeId === ownerScopeId)
    return summary.ownerScopeId === ownerScopeId && conversation
      && summary.lastMessageAt === conversation.lastMessageAt
      && Number.isFinite(Date.parse(summary.lastMessageAt))
      && summary.sourceMessageIds.length > 0
      && summary.sourceMessageIds.every((id) => conversation.messages.some((message) => message.id === id))
  }).sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt))
  // Dismissing the latest topic must not immediately replace it with an older one.
  return valid[0] && !valid[0].dismissed ? valid[0] : null
}
