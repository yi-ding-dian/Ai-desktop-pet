/**
 * 宠物 Key → 编码代理（2026-10-23）。
 *
 * 链路：后端（keyring/环境变量）→ 本机 HTTP（127.0.0.1 + 进程级 token）
 *       → Electron 主进程内存 → dsh 子进程环境变量。
 *
 * 约束：
 * - 不走 WS、不进渲染层、不落盘、不写日志；
 * - 只在真的要启动编码任务时读一次；
 * - 失败一律返回 null（回退 dsh 自己的凭据），不打断任务。
 */
/** 内部端点路径（与 backend/interfaces/ws/server.py 对齐） */
export const INTERNAL_KEY_PATH = '/internal/llm-key'

export interface RequestLlmKeyOptions {
  baseUrl: string
  token: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface LlmKeyPayload {
  key: string
  /** 宠物 LLM 当前的 API 地址（用于判断是否适用于 DeepSeek 编码代理） */
  baseUrl: string
}

/**
 * 这把 Key 是否适用于 DeepSeek 编码代理。
 * 用户把 LLM 换成别的服务商时不能盲目复用（dsh 只连 DeepSeek）。
 */
export function isDeepSeekBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'deepseek.com' || host.endsWith('.deepseek.com')
  } catch {
    return false
  }
}

/** 请求后端要 Key；任何异常都返回 null */
export async function requestLlmKey(
  options: RequestLlmKeyOptions
): Promise<LlmKeyPayload | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000)
  try {
    const response = await fetchImpl(`${options.baseUrl}${INTERNAL_KEY_PATH}`, {
      method: 'GET',
      headers: { 'X-Pet-Internal-Token': options.token },
      signal: controller.signal
    })
    if (!response.ok) return null
    const data = (await response.json()) as {
      configured?: unknown
      key?: unknown
      baseUrl?: unknown
    }
    if (data.configured !== true) return null
    if (typeof data.key !== 'string') return null
    const key = data.key.trim()
    if (!key) return null
    return {
      key,
      baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl : ''
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

