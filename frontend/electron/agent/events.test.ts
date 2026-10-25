/**
 * 任务事件翻译离线自测（node 直接运行，不联网）：
 *   npm run test:agent
 *
 * 覆盖：联网工具的 details.sources 收集（跨多次搜索按 URL 去重）
 * 与系统提示词的当前时间注入。
 */
import assert from 'node:assert/strict'
import { AgentEventTranslator } from './events'
import { priceForModel } from './pricing'
import { buildAgentSystemPrompt } from './prompt'
import { createSession } from './session'
import type { AgentEvent } from '@earendil-works/pi-agent-core'

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

async function main(): Promise<void> {
  const session = createSession('t1', '搜一下今天的新闻', '', Date.now())
  const translator = new AgentEventTranslator({
    touch: () => undefined,
    audit: () => undefined
  })
  const emit = (event: unknown): void =>
    translator.onAgentEvent(session, event as AgentEvent)

  const search = (id: string, sources: unknown[]): void => {
    emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'web_search', args: { query: '新闻' } })
    emit({
      type: 'tool_execution_end',
      toolCallId: id,
      toolName: 'web_search',
      isError: false,
      result: {
        content: [{ type: 'text', text: '[联网搜索结果] 示例' }],
        details: { sources }
      }
    })
  }

  check('来源：从工具 details 收集并保留站点/日期/摘要', () => {
    search('c1', [
      {
        index: 1,
        title: '标题一',
        url: 'https://example.com/a#h',
        snippet: '摘要一',
        site_name: '示例站',
        date: '2026-10-24'
      }
    ])
    assert.equal(session.state.sources?.length, 1)
    assert.equal(session.state.sources?.[0].title, '标题一')
    assert.equal(session.state.sources?.[0].site_name, '示例站')
  })

  check('来源：跨搜索按 URL 去重（忽略 hash 与末尾斜杠）', () => {
    search('c2', [
      { index: 1, title: '重复', url: 'https://example.com/a/', snippet: '', site_name: '', date: '' },
      { index: 2, title: '标题二', url: 'https://example.com/b', snippet: '摘要二', site_name: '', date: '' }
    ])
    assert.deepEqual(
      session.state.sources?.map((item) => item.title),
      ['标题一', '标题二']
    )
  })

  check('来源：失败/无 details 的工具结果不影响已有来源', () => {
    emit({ type: 'tool_execution_start', toolCallId: 'c3', toolName: 'web_fetch', args: { url: 'https://example.com/x' } })
    emit({
      type: 'tool_execution_end',
      toolCallId: 'c3',
      toolName: 'web_fetch',
      isError: true,
      result: { content: [{ type: 'text', text: '抓取失败' }] }
    })
    assert.equal(session.state.sources?.length, 2)
  })

  check('用量：按模型单价与请求时刻的峰谷价累计费用', () => {
    const priced = createSession('t-price', '计费', '', Date.now())
    priced.price = priceForModel('deepseek-flash')
    const costTranslator = new AgentEventTranslator({
      touch: () => undefined,
      audit: () => undefined
    })
    const at = Date.UTC(2026, 9, 26, 2, 0) // 周一 02:00 UTC = 高峰
    costTranslator.onAgentEvent(priced, { type: 'turn_start' } as AgentEvent)
    costTranslator.onAgentEvent(priced, {
      type: 'message_end',
      message: {
        role: 'assistant',
        timestamp: at,
        usage: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0 }
      }
    } as unknown as AgentEvent)
    const expected = (1000 * 2 + 2000 * 0.04 + 500 * 8) / 1_000_000
    assert.ok(Math.abs(priced.state.usage.cost - expected) < 1e-12)
    assert.ok(Math.abs(priced.roundCost - expected) < 1e-12)
  })

  check('系统提示词：注入当前本地时间与搜索日期提示', () => {
    const prompt = buildAgentSystemPrompt(new Date(2026, 9, 24, 14, 43))
    assert.match(prompt, /当前本地时间：2026-10-24 14:43/)
    assert.match(prompt, /UTC[+-]\d{2}:\d{2}/)
    assert.match(prompt, /联网搜索时把年份和日期写进关键词/)
  })

  console.log('events.test 全部通过')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
