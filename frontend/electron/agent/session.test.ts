/** 会话模型 / 持久化恢复离线自测：npm run test:agent */
import assert from 'node:assert/strict'
import { createSession, emptyState, restoreSession } from './session'

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

function record(status: Parameters<typeof restoreSession>[0]['status'], mode?: 'auto' | 'plan') {
  return {
    id: 't1',
    status,
    task: '测试',
    workspace: '/tmp/ws',
    createdAt: 1,
    updatedAt: 2,
    mode
  }
}

function main(): void {
  check('新建会话：默认标准 + 初始排队', () => {
    const session = createSession('t1', '任务', '/tmp/ws', 100)
    assert.equal(session.state.mode, 'standard')
    assert.equal(session.mode, 'standard')
    assert.equal(session.state.status, 'queued')
    assert.equal(session.running, false)
    assert.equal(session.pendingQuestion, null)
  })

  check('新建会话：可指定自动模式', () => {
    const session = createSession('t2', '任务', '/tmp/ws', 100, 'auto')
    assert.equal(session.state.mode, 'auto')
  })

  check('空态：标准模式', () => {
    assert.equal(emptyState().mode, 'standard')
  })

  check('旧记录没有 mode：回退标准', () => {
    const session = restoreSession(record('done'))
    assert.equal(session.state.mode, 'standard')
    assert.equal(session.state.status, 'done')
    assert.equal(session.state.resumable, false)
  })

  check('排队记录重启：取消', () => {
    const session = restoreSession(record('queued', 'auto'))
    assert.equal(session.state.status, 'cancelled')
    assert.match(session.state.error ?? '', /排队/)
  })

  check('计划记录重启：保留 planned 但不能执行', () => {
    const session = restoreSession(record('planned', 'plan'))
    assert.equal(session.state.status, 'planned')
    assert.equal(session.state.mode, 'plan')
    assert.equal(session.state.resumable, false)
  })

  check('中断恢复：running 步骤补 endedAt 并结束转圈', () => {
    const session = restoreSession({
      ...record('running'),
      steps: [
        {
          id: 'thinking-1',
          kind: 'thinking',
          title: '思考',
          status: 'running',
          startedAt: 1
        }
      ]
    })
    const step = session.state.steps[0]
    assert.equal(step.status, 'failed')
    assert.equal(step.endedAt, 2)
  })

  check('确认/提问不恢复', () => {
    const session = restoreSession(record('waiting'))
    assert.equal(session.pending, null)
    assert.equal(session.pendingQuestion, null)
    assert.equal(session.state.approval, undefined)
    assert.equal(session.state.question, undefined)
  })

  check('恢复：附件路径沿用，追问轮次接着旧步骤编号', () => {
    const session = restoreSession({
      ...record('done'),
      attachmentPaths: ['/tmp/a.pdf'],
      steps: [
        { id: 'round-1', kind: 'round', title: '第一轮', status: 'done', startedAt: 1 },
        { id: 'thinking-2', kind: 'thinking', turn: 2, title: '思考', status: 'done', startedAt: 2 },
        { id: 'stats-2-9', kind: 'stats', title: '统计', status: 'done', startedAt: 3 },
        { id: 'round-4', kind: 'round', title: '第四轮', status: 'done', startedAt: 4 }
      ]
    })
    assert.deepEqual(session.attachmentPaths, ['/tmp/a.pdf'])
    assert.equal(session.round, 4)
    assert.equal(session.turn, 2)
    assert.equal(session.hasTranscript, false)
  })

  console.log('session.test 全部通过')
}

main()
