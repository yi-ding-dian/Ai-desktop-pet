/** 向后端内部端点取聊天 Key（渲染层拿不到这条通道）。 */
import { internalEndpoint } from './internal-api'
import type { LlmKeyPayload } from './session'

export async function fetchLlmKey(): Promise<LlmKeyPayload> {
  const { url, token } = internalEndpoint('/internal/llm-key')
  const res = await fetch(url, { headers: { 'X-Pet-Internal-Token': token } })
  if (!res.ok) throw new Error(`读取聊天配置失败（HTTP ${res.status}）`)
  const data = (await res.json()) as {
    configured: boolean
    key: string
    baseUrl: string
    model: string
  }
  if (!data.configured || !data.key) {
    throw new Error('还没有配置聊天模型，请先到「设置 → LLM」里配置 Key')
  }
  return { key: data.key, baseUrl: data.baseUrl, model: data.model }
}
