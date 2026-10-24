/**
 * 向用户提问（scheme A，2026-10-24）。
 *
 * 模型需要用户做选择、且无法从上下文推断时调用；主进程把问题作为一张卡片
 * 推到任务面板，用户点选项或输入“其他”，答案作为工具结果回到模型，
 * 同一轮继续执行（不结束任务）。
 *
 * 这不是权限确认：写文件/执行命令的确认由 policy 决定，别用本工具代替。
 */
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { ok, type ToolContext } from './common'

export function createAskUserTool(ctx: ToolContext): AgentTool {
  const askUser: AgentTool = {
    name: 'ask_user',
    label: '询问用户',
    description:
      '当需要用户做选择或补充关键信息、且无法从上下文推断时，向用户提问。提供 2–4 个简短选项；用户也可以选“其他”自行输入。能从上下文判断、或只是执行前的权限确认时不要用它（写文件/命令的确认由系统负责）。',
    parameters: Type.Object({
      question: Type.String({ description: '要问用户的问题（一两句话，≤200 字）' }),
      options: Type.Array(Type.String({ description: '一个选项（≤80 字）' }), {
        description: '2–4 个选项',
        minItems: 2,
        maxItems: 4
      })
    }),
    execute: async (_id, params) => {
      const p = params as { question?: string; options?: string[] }
      const question = String(p.question ?? '').trim().slice(0, 200)
      if (!question) throw new Error('问题不能为空')
      const options = (Array.isArray(p.options) ? p.options : [])
        .map((item) => String(item ?? '').trim().slice(0, 80))
        .filter((item) => item.length > 0)
      const unique = Array.from(new Set(options)).slice(0, 4)
      if (unique.length < 2) throw new Error('至少提供 2 个不同的选项')
      if (!ctx.askUser) throw new Error('当前环境不支持向用户提问')
      const answer = await ctx.askUser(question, unique)
      if (!answer) {
        return ok('用户没有回答（任务已取消或结束）。不要假设答案，先停下或换个方式问。')
      }
      return ok(`用户的选择：${answer}`)
    }
  }
  return askUser
}
