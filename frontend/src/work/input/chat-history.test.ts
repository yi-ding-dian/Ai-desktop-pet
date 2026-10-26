/** 对话模式「已发送消息」派生纯函数离线自测（npm run test:work-history）。 */
import assert from 'node:assert/strict'
import type { WorkMessage } from '../store'
import { buildChatHistory } from './chat-history'

function message(overrides: Partial<WorkMessage> & Pick<WorkMessage, 'id' | 'role'>): WorkMessage {
  return {
    text: '',
    reasoning: '',
    status: 'done',
    sentAt: 0,
    createdAt: 0,
    ...overrides
  }
}

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

check('只收 user 消息，保持顺序与时间', () => {
  const history = buildChatHistory([
    message({ id: 'u1', role: 'user', text: '第一个问题', createdAt: 1000 }),
    message({ id: 'a1', role: 'assistant', text: '回答', createdAt: 1100 }),
    message({ id: 'u2', role: 'user', text: '第二个问题', createdAt: 2000 }),
    message({ id: 'a2', role: 'assistant', text: '回答二', createdAt: 2100 })
  ])
  assert.deepEqual(
    history.map((item) => [item.id, item.text, item.at]),
    [
      ['u1', '第一个问题', 1000],
      ['u2', '第二个问题', 2000]
    ]
  )
})

check('空文本 / 纯空白消息忽略', () => {
  const history = buildChatHistory([
    message({ id: 'u1', role: 'user', text: '   ' }),
    message({ id: 'u2', role: 'user', text: '有内容', createdAt: 500 })
  ])
  assert.equal(history.length, 1)
  assert.equal(history[0].id, 'u2')
})

check('缺失时间置 null，空会话返回空数组', () => {
  const history = buildChatHistory([
    message({ id: 'u1', role: 'user', text: '无时间', createdAt: Number.NaN })
  ])
  assert.equal(history[0].at, null)
  assert.deepEqual(buildChatHistory([]), [])
})

console.log('message/chat-history.test 全部通过')
