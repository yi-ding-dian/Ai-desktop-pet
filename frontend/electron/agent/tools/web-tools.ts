/**
 * 联网搜索 / 网页抓取两个只读工具（2026-10-24）。
 *
 * 开关、结果条数、超时、5 QPS 节流、错误翻译与结果格式化全部在后端
 * （SearchService / DeepSeek Search）。这里只经主进程注入的 `callInternal`
 * 走内部端点，保证「设置 → 搜索」是唯一口径，不另立一份配置。
 *
 * 只读、免确认：与会话模式的联网搜索一致。
 */
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AgentSourceItem } from '../types'
import { ok, type ToolContext } from './common'

/** 工具结果带上结构化来源：主进程从 details 收集给悬浮卡片（不发给模型） */
function okWithSources(
  text: string,
  sources: AgentSourceItem[] | undefined
): { content: Array<{ type: 'text'; text: string }>; details: { sources: AgentSourceItem[] } } {
  return { content: [{ type: 'text', text }], details: { sources: sources ?? [] } }
}

function requireInternal(ctx: ToolContext): NonNullable<ToolContext['callInternal']> {
  const call = ctx.callInternal
  if (!call) throw new Error('当前环境不支持联网搜索')
  return call
}

export function createWebSearch(ctx: ToolContext): AgentTool {
  const webSearch: AgentTool = {
    name: 'web_search',
    label: '联网搜索',
    description:
      '联网搜索实时网页（DeepSeek Search）。用户问最新/今天/最近/实时/新闻/价格/天气/版本发布等当前信息，或明确说「搜一下/查一下/搜索」时调用。query 用简洁关键词（1–128 字）。搜索是否可用由「设置 → 搜索」的开关决定；返回结果会作为资料给你阅读，引用时用 [1][2] 并列出标题与 URL。不要搜索用户隐私或本地文件内容。',
    parameters: Type.Object({
      query: Type.String({ description: '搜索关键词（1–128 字）' })
    }),
    execute: async (_id, params) => {
      const query = String((params as { query?: string }).query ?? '').trim()
      if (!query) throw new Error('搜索词不能为空')
      const result = await requireInternal(ctx)('/internal/search', { query })
      // 失败（含「设置 → 搜索」未开启）抛出去：步骤标红，说明原样回给模型
      if (!result.ok) throw new Error(result.modelContent || result.message || '联网搜索失败')
      return okWithSources(
        result.modelContent || result.message || '没有搜索到相关内容',
        result.sources
      )
    }
  }
  return webSearch
}

export function createWebFetch(ctx: ToolContext): AgentTool {
  const webFetch: AgentTool = {
    name: 'web_fetch',
    label: '抓取网页',
    description:
      '抓取一个 http/https 网页并读取 Markdown 正文（DeepSeek Fetch）。用户给出具体链接让你看看/总结/读一下，或搜索结果里的页面需要细读时调用。不要抓取需要登录、明显私密或本机/内网的地址；返回正文会作为资料给你阅读。',
    parameters: Type.Object({
      url: Type.String({ description: '要抓取的 http/https 链接' })
    }),
    execute: async (_id, params) => {
      const url = String((params as { url?: string }).url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 链接')
      const result = await requireInternal(ctx)('/internal/fetch', { url })
      if (!result.ok) throw new Error(result.modelContent || result.message || '网页抓取失败')
      return okWithSources(
        result.modelContent || result.message || '没有抓到可用的网页内容',
        result.sources
      )
    }
  }
  return webFetch
}
