/**
 * 工具域（§4.7 工具机制）：后端 `tool_call` 事件 → 前端执行器。
 *
 * 背景：工具调用由后端（快通道关键词 / 模型 tools 协议）识别并推 `tool_call` 事件
 * （在对应回复的 reply_end 之后），本域统一按 name 分派到具体执行器——首期仅
 * `open_settings` → 打开设置窗口（§7.6.1 入口已从 teaching 域关键词迁至后端）。
 *
 * 设计取舍：
 * - 执行落在前端：开窗等能力属主进程/渲染侧（window.pet bridge），后端只声明"要调什么"，
 *   不感知前端实现；
 * - 未知 name 记录日志并忽略：前后端版本漂移（后端先上新工具）时静默降级，不打断对话；
 * - bridge 调用可选链容错：旧 preload 无 settings 段时静默跳过（同 teaching 域惯例）。
 */
import { getPetBridge } from '../../shared/pet-bridge'
import type { WsClient } from '../../shared/ws-client'

/** dev 态日志（便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[tools] ${msg}`)
}

/**
 * 工具执行器表（name → 执行函数）。
 * 新增内置工具在此登记一条；args 按各工具契约解析（当前 open_settings 无参数，忽略之）。
 */
const TOOL_EXECUTORS = new Map<string, (args: Record<string, unknown>) => void>([
  [
    'open_settings',
    () => {
      devLog('open_settings → 请求打开设置窗口')
      getPetBridge().settings?.open?.()
    }
  ]
])

/**
 * 工具执行器接线（App 挂载时调用一次；返回清理函数）。
 * StrictMode 双调用安全：每次 setup 注册独立订阅，清理函数经 client.on 的 unsubscribe 释放。
 */
export function setupToolExecutor(client: WsClient): () => void {
  const offToolCall = client.on('tool_call', ({ id, name, args }) => {
    devLog(`收到工具调用：name=${name} id=${id} args=${JSON.stringify(args)}`)
    const executor = TOOL_EXECUTORS.get(name)
    if (!executor) {
      devLog(`未知工具（已忽略）：name=${name}`)
      return
    }
    executor(args)
  })
  return () => {
    offToolCall()
  }
}
