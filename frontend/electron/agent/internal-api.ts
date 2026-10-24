/**
 * 后端内部端点调用（主进程专用，2026-10-24）。
 *
 * 内部端点用 PET_INTERNAL_TOKEN 鉴权，令牌只给主进程、不下发渲染层；
 * 这里集中处理"后端未就绪"与超时，避免每个调用点多写一份。
 */
import { backendManager } from '../backend-process'
import type { InternalResult } from './tools/common'

/** 后端 provider 的单次超时是 15s（含一次重试），这里再留余量 */
const INTERNAL_TIMEOUT_MS = 45_000

/** 内部端点地址与凭据（后端未就绪时直接抛可读错误） */
export function internalEndpoint(path: string): { url: string; token: string } {
  const token = backendManager.getInternalToken()
  const snapshot = backendManager.getSnapshot()
  if (!token || !snapshot.port) throw new Error('后端还没就绪，请稍后再试')
  return { url: `http://127.0.0.1:${snapshot.port}${path}`, token }
}

/** POST 内部端点：非 200 与网络错误都转成可读错误，不把 HTML 错误页回给模型。 */
export async function callInternal(
  path: string,
  body: Record<string, unknown>
): Promise<InternalResult> {
  const { url, token } = internalEndpoint(path)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pet-Internal-Token': token
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(INTERNAL_TIMEOUT_MS)
    })
  } catch (err) {
    console.warn('[agent] 内部端点请求失败：', err)
    throw new Error('连不上本地后端，请稍后再试')
  }
  if (!res.ok) {
    // 503 = 后端未装配该能力；其余按状态码提示
    throw new Error(`请求失败（HTTP ${res.status}），请稍后再试`)
  }
  try {
    return (await res.json()) as InternalResult
  } catch {
    throw new Error('后端返回了无法解析的结果')
  }
}
