/**
 * 工具域（§4.7 工具机制）：后端 `tool_call` 事件 → 前端执行器。
 *
 * 背景：工具调用由后端（快通道关键词 / 模型 tools 协议）识别并推 `tool_call` 事件
 * （在对应回复的 reply_end 之后），本域统一按 name 分派到具体执行器。
 *
 * 2026-10-18 记忆本：
 * - `open_item`：后端已把 name 解析成精确的 kind/value，这里只负责调
 *   system.openExternal（链接）或 system.openPath（本机文件/文件夹）；
 * - `delete_path`：后端已校验路径与保护目录，这里调主进程的
 *   system.deletePathWithConfirm——主进程弹「删除/取消」确认气泡，**用户点删除
 *   后**才移入回收站；成功后回传后端移除记忆本记录、清理长期记忆。
 *
 * 设计取舍：
 * - 执行落在前端：开窗/打开文件等能力属主进程/渲染侧（window.pet bridge），后端只
 *   声明"要调什么"，不感知前端实现；
 * - 未知 name 记录日志并忽略：前后端版本漂移（后端先上新工具）时静默降级，不打断对话；
 * - bridge 调用可选链容错：旧 preload 无新方法时静默跳过并给本地短提示。
 */
import { getPetBridge } from '../../shared/pet-bridge'
import type { WsClient } from '../../shared/ws-client'

/** dev 态日志（便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[tools] ${msg}`)
}

/** 取字符串参数（非字符串按空串，避免 String(null) 变成 "null"） */
function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 本地短提示（5s 自动收起）：工具执行结果不经过对话流水线时，用说话气泡
 * 把"已放进回收站 / 没删成 / 打不开"告诉用户，避免点了确认后没有任何反馈。
 */
function speakLocal(text: string): void {
  if (!text) return
  try {
    const bubble = getPetBridge().bubble
    bubble?.setNextSpeechTtl?.(5000)
    bubble?.sayBegin?.({ kind: 'chat' })
    bubble?.sayText?.(text)
    bubble?.sayEnd?.(false)
  } catch (err) {
    devLog(`本地提示失败：${String(err)}`)
  }
}

/** 工具执行器签名：args + 当前 WS 客户端（delete_path 成功后回传后端清理记录） */
type ToolExecutor = (args: Record<string, unknown>, client: WsClient) => void | Promise<void>

/**
 * 工具执行器表（name → 执行函数）。
 * 新增内置工具在此登记一条；args 按各工具契约解析。
 */
const TOOL_EXECUTORS = new Map<string, ToolExecutor>([
  [
    'open_settings',
    () => {
      devLog('open_settings → 请求打开设置窗口')
      getPetBridge().settings?.open?.()
    }
  ],
  [
    'open_work',
    () => {
      devLog('open_work → 请求打开工作模式窗口')
      getPetBridge().work?.open?.()
    }
  ],
  [
    'open_item',
    async (args) => {
      const kind = str(args, 'kind')
      const value = str(args, 'value')
      if (!value) {
        speakLocal('没找到要打开的内容。')
        return
      }
      const system = getPetBridge().system
      if (!system?.openExternal || !system?.openPath) {
        speakLocal('这个版本还不支持打开链接或文件。')
        return
      }
      if (kind === 'program') {
        // 后端 prepare_open 已拒绝程序条目；这里只做版本漂移兜底
        speakLocal('这是一个程序，说“运行它”我就会启动。')
        return
      }
      devLog(`open_item → ${kind}: ${value}`)
      try {
        const result =
          kind === 'path' ? await system.openPath(value) : await system.openExternal(value)
        if (!result.ok) speakLocal(result.message || '打不开这个链接或文件。')
      } catch (err) {
        devLog(`open_item 失败：${String(err)}`)
        speakLocal('打不开这个链接或文件。')
      }
    }
  ],
  [
    'delete_path',
    async (args, client) => {
      const path = str(args, 'path')
      const name = str(args, 'name')
      if (!path) {
        speakLocal('没找到要删除的路径。')
        return
      }
      const system = getPetBridge().system
      if (!system?.deletePathWithConfirm) {
        speakLocal('这个版本还不支持删除文件。')
        return
      }
      devLog(`delete_path → 请求确认：${path}`)
      let result
      try {
        result = await system.deletePathWithConfirm(path, name || undefined)
      } catch (err) {
        devLog(`delete_path 确认失败：${String(err)}`)
        speakLocal('确认气泡没弹出来，再试一次好吗？')
        return
      }
      if (!result.confirmed) {
        speakLocal(result.message || '好，不删了。')
        return
      }
      if (!result.ok) {
        speakLocal(result.message || '没删成，可能没有权限。')
        return
      }
      speakLocal(name ? `已经把『${name}』放进回收站啦。` : '已经放进回收站啦。')
      // 主进程已确认移入回收站：让后端移除记忆本记录、清理长期记忆。
      // 断线时回传失败，记录会在下次打开时显示“路径不存在”，可手动删。
      try {
        client.send('memory_book_file_deleted', { path })
      } catch (err) {
        devLog(`memory_book_file_deleted 回传失败：${String(err)}`)
      }
    }
  ],
  [
    'run_program',
    async (args) => {
      // 后端 prepare_run_program 已把来源解析成三种 kind：
      // program=记忆本登记（免确认）；app=已安装应用（主进程匹配、免确认）；
      // path=用户临时给出的路径（主进程弹确认气泡）。
      const kind = str(args, 'kind')
      const name = str(args, 'name')
      const path = str(args, 'path')
      const launcher = getPetBridge().launcher
      if (!launcher?.runProgram) {
        speakLocal('这个版本还不支持启动程序。')
        return
      }

      if (kind === 'app') {
        if (!name) {
          speakLocal('要运行哪个程序？')
          return
        }
        devLog(`run_program → 安装应用：${name}`)
        try {
          const result = await launcher.runProgram({ mode: 'name', name })
          if (!result.ok) speakLocal(result.message || `没能启动『${name}』。`)
        } catch (err) {
          devLog(`run_program 失败：${String(err)}`)
          speakLocal('没能启动这个程序。')
        }
        return
      }

      if (!path) {
        speakLocal('没找到要运行的程序。')
        return
      }
      devLog(`run_program → ${kind}: ${path}`)
      try {
        const result = await launcher.runProgram({
          mode: 'path',
          path,
          name: name || undefined,
          // 只有记忆本登记条目免确认；临时路径由主进程弹确认气泡
          trusted: kind === 'program'
        })
        if (!result.ok) speakLocal(result.message || '没能启动这个程序。')
      } catch (err) {
        devLog(`run_program 失败：${String(err)}`)
        speakLocal('没能启动这个程序。')
      }
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
    try {
      void Promise.resolve(executor(args, client)).catch((err: unknown) => {
        devLog(`工具 ${name} 执行异常：${String(err)}`)
      })
    } catch (err) {
      devLog(`工具 ${name} 执行异常：${String(err)}`)
    }
  })
  return () => {
    offToolCall()
  }
}
