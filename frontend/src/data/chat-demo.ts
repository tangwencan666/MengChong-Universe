import type { ChatSession, PreviewIdentityId, RecentConversationSummary } from '../features/chat/types'

// Explicitly fictional fixtures. No fetched user history or persisted browser data.
const demoChatTemplates: Omit<ChatSession, 'ownerScopeId'>[] = [
  {
    id: 'demo-mood', title: '今天有一点累', source: 'demo', lastMessageAt: '2026-10-31T12:30:00Z',
    messages: [
      { id: 'mood-1', role: 'user', content: '今天事情有点多，想安静地待一会儿。', status: 'complete' },
      { id: 'mood-2', role: 'assistant', content: '【虚构演示】想安静一会儿也可以。如果愿意，可以聊聊今天让你觉得累的一件事。\n\n这是一段用于展示历史会话的示例，不是真实模型回复。', status: 'complete' },
      { id: 'mood-3', role: 'user', content: '我想给这一周留一点自己的时间。', status: 'complete' },
      { id: 'mood-4', role: 'assistant', content: '【虚构演示】可以留一点时间做喜欢的小事，也可以什么都不安排。用自己舒服的节奏就好。', status: 'complete' },
    ],
  },
  {
    id: 'demo-interview', title: '周末想做点喜欢的事', source: 'demo', lastMessageAt: '2026-10-30T10:00:00Z',
    messages: [
      { id: 'interview-1', role: 'user', content: '周末想去散步，也想找一本喜欢的书。', status: 'complete' },
      { id: 'interview-2', role: 'assistant', content: '【虚构演示】听起来是个轻松的周末。可以随意走走，也可以先聊聊你喜欢什么样的书。\n\n这段文字只用于演示会话布局，不代表真实模型建议。', status: 'complete' },
    ],
  },
]

/** Explicitly loaded preview fixtures, partitioned by mock visitor. Never automatic. */
export function createDemoHistory(ownerScopeId: PreviewIdentityId) {
  const sessions: ChatSession[] = structuredClone(demoChatTemplates).map((item) => ({
    ...item, id: `${ownerScopeId}-${item.id}`, ownerScopeId,
    messages: item.messages.map((message) => ({ ...message, id: `${ownerScopeId}-${message.id}` })),
  }))
  const summaries: RecentConversationSummary[] = sessions.map((session) => ({
    conversationId: session.id, ownerScopeId, title: session.title,
    summary: session.id.endsWith('demo-mood') ? '忙碌了一天，想给这一周留一点自己的时间。' : '周末想散步、找一本喜欢的书。',
    followUpText: session.id.endsWith('demo-mood')
      ? '上次你想给自己留一点时间。今天愿意接着聊聊吗？'
      : '上次你想聊聊散步和喜欢的书。今天想从哪里接着聊？',
    lastMessageAt: session.lastMessageAt, source: 'mock', dismissed: false,
    sourceMessageIds: session.messages.filter((message) => message.role === 'user').map((message) => message.id),
  }))
  return { sessions, summaries }
}
