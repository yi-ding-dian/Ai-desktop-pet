/** 待办清单工具（整表替换，回调交给 service）。 */
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { ok, type ToolContext } from './common'

export function createTodoTool(ctx: ToolContext): AgentTool {
  const todo: AgentTool = {
    name: 'todo',
    label: '更新待办',
    description:
      '设置当前任务的待办清单（整表替换）。多步任务开始前先拆解，做到哪条就把哪条改成 done。',
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          text: Type.String({ description: '待办内容，一句话' }),
          status: Type.String({ description: 'pending / active / done' })
        })
      )
    }),
    execute: async (_id, params) => {
      const p = params as { items: Array<{ text: string; status: string }> }
      const items = (p.items ?? [])
        .filter((item) => item && typeof item.text === 'string')
        .slice(0, 20)
        .map((item) => ({
          text: item.text.slice(0, 200),
          status:
            item.status === 'done' || item.status === 'active'
              ? (item.status as 'done' | 'active')
              : ('pending' as const)
        }))
      ctx.onTodo(items)
      const done = items.filter((item) => item.status === 'done').length
      return ok(`待办已更新：${done}/${items.length} 完成`)
    }
  }
  return todo
}
