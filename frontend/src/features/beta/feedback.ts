export const feedbackCategories = ['installation', 'connection', 'window', 'performance', 'other'] as const
export type FeedbackCategory = typeof feedbackCategories[number]

export function makeFeedback(category: FeedbackCategory, reportId: string, at: string) {
  if (!feedbackCategories.includes(category) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reportId) || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
    throw new Error('反馈单字段无效。')
  }
  return { schema: 'weibiye-feedback/1', category, report_id: reportId, created_at: at,
    notice: '仅含用户选择的类别、随机编号及时间；没有聊天、账号、设备信息或密钥。不会自动发送。' }
}
