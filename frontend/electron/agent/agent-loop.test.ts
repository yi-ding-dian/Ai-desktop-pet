/**
 * 任务代理离线集成自测（node 直接运行，不联网）：
 *   npm run test:agent
 *
 * 用 pi-ai 的 faux provider 跑完整循环：读文件（免确认）→ 写文件（被拒绝）→ 收尾。
 * 验证：工具 schema 能被 pi-agent-core 校验、beforeToolCall 能阻断执行、
 * 事件流能拿到工具名/参数/结果。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Agent } from '@earendil-works/pi-agent-core'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall
} from '@earendil-works/pi-ai'
import { createTools } from './tools'

async function main(): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-loop-')))
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello from workspace\n')

  const faux = fauxProvider({ tokensPerSecond: 0 })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read_file', { path: 'a.txt' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage(
      [fauxToolCall('write_file', { path: 'b.txt', content: 'should not exist' })],
      { stopReason: 'toolUse' }
    ),
    fauxAssistantMessage([fauxText('读完了；写入被你拒绝，我停下了。')])
  ])

  const events: string[] = []
  const blocked: string[] = []
  const todos: unknown[] = []

  const agent = new Agent({
    initialState: {
      systemPrompt: 'test',
      model,
      tools: createTools({ workspace: root, onTodo: (items) => todos.push(items) })
    },
    streamFn: models.streamSimple.bind(models),
    beforeToolCall: async ({ toolCall }) => {
      if (toolCall.name === 'read_file') return undefined
      if (toolCall.name === 'write_file') {
        blocked.push(toolCall.name)
        return { block: true, reason: '用户拒绝了这次操作' }
      }
      return undefined
    }
  })

  agent.subscribe((event) => {
    if (event.type === 'tool_execution_start') events.push(`start:${event.toolName}`)
    if (event.type === 'tool_execution_end') {
      events.push(`${event.isError ? 'fail' : 'ok'}:${event.toolName}`)
    }
  })

  await agent.prompt('读取 a.txt，然后写 b.txt')

  assert.deepEqual(blocked, ['write_file'], '写文件应当经过审批并被拒绝')
  // tool_execution_start 在 beforeToolCall 之前发出，被拦的调用也会先有 start
  assert.deepEqual(events, [
    'start:read_file',
    'ok:read_file',
    'start:write_file',
    'fail:write_file'
  ])
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false, '被拒绝的写入不得落盘')

  // 工具结果要进入下一轮上下文（faux 第二轮能拿到 toolResult）
  type AnyMessage = { role: string; toolName?: string; isError?: boolean; content?: unknown }
  const messages = agent.state.messages as AnyMessage[]
  const results = messages.filter((message) => message.role === 'toolResult')
  const readResult = results.find((message) => message.toolName === 'read_file')
  const writeResult = results.find((message) => message.toolName === 'write_file')
  assert.ok(readResult && writeResult, '读/写各应有一条 toolResult')
  assert.match(JSON.stringify(readResult), /hello from workspace/, '读取内容应回传给模型')
  assert.equal(writeResult.isError, true, '被拒绝的调用应标记为错误结果')
  assert.match(JSON.stringify(writeResult), /用户拒绝了这次操作/, '拒绝原因应回传给模型')

  // 继续追问：同一个 Agent 再跑一轮，上下文（含上一轮工具结果）必须还在
  faux.setResponses([fauxAssistantMessage([fauxText('第二轮完成')])])
  const before = agent.state.messages.length
  await agent.prompt('再总结一下')
  assert.ok(agent.state.messages.length > before, '追问应追加消息而不是重开')
  const users = (agent.state.messages as AnyMessage[]).filter((message) => message.role === 'user')
  assert.equal(users.length, 2, '两轮各有一条用户消息')
  console.log('ok - 继续追问保留上下文')

  fs.rmSync(root, { recursive: true, force: true })
  console.log('ok - agent-loop：读通过 / 写被拒 / 拒绝原因回传')
  console.log('agent-loop.test 全部通过')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
