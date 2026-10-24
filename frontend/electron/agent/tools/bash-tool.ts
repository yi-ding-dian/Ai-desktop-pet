/** 命令执行工具（每次调用由 service 弹确认卡）。 */
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { BASH_DEFAULT_TIMEOUT, BASH_MAX_TIMEOUT, runCommand } from './shell'
import { ok } from './common'

export function createBashTool(root: string): AgentTool {
  const bash: AgentTool = {
    name: 'bash',
    label: '执行命令',
    description:
      '在工作区目录下执行一条 shell 命令（如跑测试、构建）。每次执行都会请用户确认；超时默认 120 秒。',
    parameters: Type.Object({
      command: Type.String({ description: '要执行的完整命令' }),
      timeout_ms: Type.Optional(Type.Number({ description: '超时毫秒数，默认 120000，上限 600000' }))
    }),
    execute: async (_id, params, signal, onUpdate) => {
      const p = params as { command: string; timeout_ms?: number }
      const command = (p.command ?? '').trim()
      if (!command) throw new Error('命令不能为空')
      const timeout = Math.min(
        Math.max(Math.trunc(p.timeout_ms ?? BASH_DEFAULT_TIMEOUT), 1_000),
        BASH_MAX_TIMEOUT
      )
      const startedAt = Date.now()
      const progress = setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000)
        onUpdate?.({
          content: [{ type: 'text', text: `已运行 ${seconds} 秒…` }],
          details: { seconds }
        })
      }, 1000)
      let result
      try {
        result = await runCommand(command, root, timeout, signal)
      } finally {
        clearInterval(progress)
      }
      if (result.aborted) throw new Error('命令已被中止')
      if (result.timedOut) {
        throw new Error(`命令超时（${Math.round(timeout / 1000)} 秒）已终止\n${result.output.slice(-2000)}`)
      }
      const text = result.output || '（无输出）'
      if (result.code !== 0) {
        throw new Error(`命令退出码 ${result.code}\n${text}`)
      }
      return ok(text)
    }
  }
  return bash
}
