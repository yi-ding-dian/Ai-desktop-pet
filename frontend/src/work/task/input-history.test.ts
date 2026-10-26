/**
 * 「已发送消息」派生纯函数离线自测（npm run test:work-task）。
 */
import assert from 'node:assert/strict'
import type { AgentState, AgentStep } from '../../../electron/ipc/channels'
import { TASK_START_ID, buildTaskHistory } from './input-history'

function step(overrides: Partial<AgentStep> & Pick<AgentStep, 'id' | 'kind' | 'title'>): AgentStep {
  return { status: 'done', startedAt: 0, ...overrides }
}

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 'task-1',
    status: 'done',
    task: '看看这个文件',
    workspace: 'D:/work',
    mode: 'standard',
    startedAt: 1000,
    steps: [],
    todos: [],
    usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 },
    resumable: true,
    ...overrides
  } as AgentState
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

check('空态 / 没有任务 id 返回空', () => {
  assert.deepEqual(buildTaskHistory(null), [])
  assert.deepEqual(buildTaskHistory(state({ id: '' })), [])
})

check('初始任务 + round 步骤，最旧在前最新在后', () => {
  const history = buildTaskHistory(
    state({
      steps: [
        step({ id: 'thinking-1', kind: 'thinking', title: '思考过程', startedAt: 1100 }),
        step({ id: 'round-1', kind: 'round', title: '第一条追问', startedAt: 2000 }),
        step({ id: 'text-1', kind: 'text', title: '回答', detail: '回答正文', startedAt: 2100 }),
        step({ id: 'round-2', kind: 'round', title: '第二条追问', startedAt: 3000 })
      ]
    })
  )

  assert.deepEqual(
    history.map((item) => [item.id, item.text, item.kind, item.at]),
    [
      [TASK_START_ID, '看看这个文件', 'start', 1000],
      ['round-1', '第一条追问', 'round', 2000],
      ['round-2', '第二条追问', 'round', 3000]
    ]
  )
})

check('只收用户消息：thinking/text/tool/stats 全部忽略', () => {
  const history = buildTaskHistory(
    state({
      steps: [
        step({ id: 'thinking-1', kind: 'thinking', title: '思考过程' }),
        step({ id: 'tool-1', kind: 'tool', title: '读取文件' }),
        step({ id: 'stats-1', kind: 'stats', title: '本轮统计' }),
        step({ id: 'text-1', kind: 'text', title: '回答', detail: '正文' })
      ]
    })
  )
  assert.equal(history.length, 1)
  assert.equal(history[0].id, TASK_START_ID)
})

check('空文本与缺失时间：过滤空 round，时间置 null', () => {
  const history = buildTaskHistory(
    state({
      startedAt: undefined,
      steps: [
        step({ id: 'round-1', kind: 'round', title: '   ', startedAt: 2000 }),
        step({ id: 'round-2', kind: 'round', title: '有内容', startedAt: 3000 })
      ]
    })
  )
  assert.equal(history.length, 2)
  assert.equal(history[0].at, null)
  assert.deepEqual(
    history.map((item) => item.id),
    [TASK_START_ID, 'round-2']
  )
})

check('时间乱序时按时间排序；缺失时间时保持步骤顺序', () => {
  const sorted = buildTaskHistory(
    state({
      steps: [
        step({ id: 'round-1', kind: 'round', title: '晚', startedAt: 5000 }),
        step({ id: 'round-2', kind: 'round', title: '早', startedAt: 2000 })
      ]
    })
  )
  assert.deepEqual(
    sorted.slice(1).map((item) => item.id),
    ['round-2', 'round-1']
  )

  const fallback = buildTaskHistory(
    state({
      steps: [
        step({ id: 'round-1', kind: 'round', title: '一', startedAt: undefined as unknown as number }),
        step({ id: 'round-2', kind: 'round', title: '二', startedAt: undefined as unknown as number })
      ]
    })
  )
  assert.deepEqual(
    fallback.slice(1).map((item) => item.id),
    ['round-1', 'round-2']
  )
})

console.log('history.test 全部通过')
