/** 任务对话记录落盘 / 裁剪离线自测：npm run test:agent-transcript */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { buildAgent } from './pi'
import {
  deleteTranscript,
  hasTranscript,
  loadTranscript,
  pruneTranscripts,
  sanitizeMessages,
  saveTranscript,
  trimMessages
} from './transcript'

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

const system = (text: string): AgentMessage =>
  ({ role: 'system', content: text, timestamp: 1 }) as unknown as AgentMessage
const user = (text: string): AgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 2 }) as unknown as AgentMessage
const assistant = (content: unknown[]): AgentMessage =>
  ({ role: 'assistant', content, timestamp: 3 }) as unknown as AgentMessage
const toolResult = (id: string, content: unknown[]): AgentMessage =>
  ({ role: 'toolResult', toolCallId: id, toolName: 'read_file', content, isError: false, timestamp: 4 }) as unknown as AgentMessage

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'pet-transcript-'))
  try {
    check('装配：历史追加在新 system 之后（不覆盖当天提示词）', () => {
      const built = buildAgent({
        apiKey: 'test-key',
        baseUrl: '',
        model: 'deepseek-chat',
        mode: 'standard',
        tools: [],
        beforeToolCall: async () => undefined,
        history: [user('历史问题'), assistant([{ type: 'text', text: '历史回答' }])]
      })
      const messages = built.agent.state.messages
      assert.equal(messages[0].role, 'system')
      assert.equal(messages[1].role, 'user')
      assert.equal(messages[2].role, 'assistant')
    })

    check('保存/读取：开头的 system 不落盘，装配时按当天配置重建', () => {
      const result = saveTranscript(
        't1',
        [
          system('旧的系统提示'),
          user('你好'),
          assistant([{ type: 'text', text: '在' }])
        ],
        '概要',
        dir
      )
      assert.equal(result.saved, true)
      const loaded = loadTranscript('t1', dir)
      assert.ok(loaded)
      assert.equal(loaded.length, 2)
      assert.equal(loaded[0].role, 'user')
      assert.equal(loaded[1].role, 'assistant')
    })

    check('清理：思考内容丢弃、图片换占位、工具结果截断', () => {
      const cleaned = sanitizeMessages([
        system('提示'),
        user('看图'),
        assistant([
          { type: 'thinking', thinking: '内部推理' },
          { type: 'text', text: '我看看' },
          {
            type: 'toolCall',
            id: 'c1',
            name: 'write_file',
            arguments: { path: 'a.txt', content: 'x'.repeat(5000) }
          }
        ]),
        toolResult('c1', [
          { type: 'text', text: 'y'.repeat(20_000) },
          { type: 'image', data: 'base64', mimeType: 'image/png' }
        ])
      ])
      const assistantMessage = cleaned.find((message) => message.role === 'assistant') as unknown as {
        content: Array<Record<string, unknown>>
      }
      assert.equal(assistantMessage.content.some((block) => block.type === 'thinking'), false)
      const call = assistantMessage.content.find((block) => block.type === 'toolCall') as {
        arguments: { content: string }
      }
      assert.ok(call.arguments.content.length < 5000)
      assert.ok(call.arguments.content.endsWith('…[已截断]'))

      const result = cleaned.find((message) => message.role === 'toolResult') as unknown as {
        content: Array<Record<string, unknown>>
      }
      const text = result.content[0].text as string
      assert.ok(text.length < 7_000)
      assert.ok(text.includes('中间省略'))
      assert.equal(result.content[1].type, 'text')
      assert.ok(String(result.content[1].text).includes('图片结果已省略'))
    })

    check('半轮工具调用：没有结果的尾部整段丢弃', () => {
      const cleaned = sanitizeMessages([
        user('开始'),
        assistant([
          { type: 'toolCall', id: 'a', name: 'read_file', arguments: { path: 'a' } },
          { type: 'toolCall', id: 'b', name: 'read_file', arguments: { path: 'b' } }
        ]),
        toolResult('a', [{ type: 'text', text: '只有一半' }])
      ])
      assert.deepEqual(
        cleaned.map((message) => message.role),
        ['user']
      )
    })

    check('裁剪：从 user 处对齐，并插入带标记的概要', () => {
      const messages: AgentMessage[] = []
      for (let i = 0; i < 40; i += 1) {
        messages.push(user(`第 ${i} 轮`), assistant([{ type: 'text', text: 'x'.repeat(5_000) }]))
      }
      const { kept, dropped } = trimMessages(messages, 4_000, 400)
      assert.ok(dropped > 0)
      assert.ok(kept.length > 0)
      assert.equal(kept[0].role, 'user')

      saveTranscript('t2', messages, '【概要】前面的内容', dir)
      const loaded = loadTranscript('t2', dir)
      assert.ok(loaded)
      assert.equal(loaded[0].role, 'system')
      assert.equal((loaded[0] as unknown as { transcriptRecap?: boolean }).transcriptRecap, true)
      assert.ok(String((loaded[0] as unknown as { content: string }).content).includes('概要'))
    })

    check('再次保存：旧概要不会滚雪球', () => {
      const long: AgentMessage[] = [user('起点')]
      for (let i = 0; i < 40; i += 1) {
        long.push(user(`轮 ${i}`), assistant([{ type: 'text', text: 'z'.repeat(5_000) }]))
      }
      saveTranscript('t3', long, '旧概要', dir)
      const first = loadTranscript('t3', dir)
      assert.ok(first)
      assert.equal(
        (first[0] as unknown as { transcriptRecap?: boolean }).transcriptRecap,
        true
      )

      // 在带旧概要的历史上继续追加，再次触发裁剪
      const messages = [system('新提示'), ...first]
      for (let i = 0; i < 10; i += 1) {
        messages.push(user(`追加 ${i}`), assistant([{ type: 'text', text: 'y'.repeat(5_000) }]))
      }
      saveTranscript('t3', messages, '新概要', dir)
      const loaded = loadTranscript('t3', dir)
      assert.ok(loaded)
      const recaps = loaded.filter(
        (message) => (message as unknown as { transcriptRecap?: boolean }).transcriptRecap === true
      )
      assert.equal(recaps.length, 1)
      assert.ok(
        String((recaps[0] as unknown as { content: string }).content).includes('新概要')
      )
    })

    check('损坏文件：返回 null，不当成空上下文', () => {
      writeFileSync(join(dir, 'broken.json'), '{not json', 'utf8')
      assert.equal(loadTranscript('broken', dir), null)
    })

    check('修剪旧任务：没有对应会话的 transcript 被删除', () => {
      assert.equal(hasTranscript('t1', dir), true)
      pruneTranscripts(['t2'], dir)
      assert.equal(hasTranscript('t1', dir), false)
      assert.equal(hasTranscript('t2', dir), true)
      deleteTranscript('t2', dir)
      assert.equal(hasTranscript('t2', dir), false)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main()
