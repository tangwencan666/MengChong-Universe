import axios from 'axios'

export const apiBase = import.meta.env.VITE_API_BASE_URL ?? ''
export const api = axios.create({ baseURL: apiBase, timeout: 10_000, withCredentials: true })

let generation = 0
let csrf: string | null = null
let csrfRequest: Promise<string> | null = null
const scopes = new WeakMap<object, number>()

export function resetAuthTransport() {
  generation += 1
  csrf = null
  csrfRequest = null
}

async function getCsrf(): Promise<string> {
  if (csrf) return csrf
  if (csrfRequest) return csrfRequest
  const scope = generation
  const pending = api.get<{ csrf_token: string }>('/api/v1/auth/csrf').then(({ data }) => {
    if (scope !== generation) throw new axios.CanceledError('账户状态已变更，请重试。')
    csrf = data.csrf_token
    return csrf
  }).finally(() => { if (scope === generation) csrfRequest = null })
  csrfRequest = pending
  return pending
}

api.interceptors.request.use(async (config) => {
  const scope = generation
  scopes.set(config, scope)
  if (['post', 'put', 'patch', 'delete'].includes(config.method ?? 'get')) {
    const token = await getCsrf()
    if (scope !== generation) throw new axios.CanceledError('账户状态已变更，请重试。')
    config.headers.set('X-CSRF-Token', token)
  }
  return config
})

api.interceptors.response.use((response) => response, (error: unknown) => {
  if (axios.isAxiosError(error) && error.config && scopes.get(error.config) === generation) {
    if (error.response?.status === 401 && !error.config.url?.endsWith('/auth/login')) {
      window.dispatchEvent(new Event('weibiye:unauthenticated'))
    }
    if (error.response?.status === 403) csrf = null
  }
  return Promise.reject(error)
})

export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { error?: { message?: string }; request_id?: string } | undefined
    if (data?.error?.message) {
      return `${data.error.message}${data.request_id ? `（请求 ID：${data.request_id}）` : ''}`
    }
    if (!error.response) return '暂时无法连接服务，请检查网络或稍后重试。'
    return `请求失败（HTTP ${error.response.status}）。`
  }
  return error instanceof Error ? error.message : '操作失败，请稍后重试。'
}
