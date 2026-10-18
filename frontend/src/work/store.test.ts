/**
 * 工作窗消息 reducer——离线自测（纯函数，不依赖 Electron/DOM）。
 *
 * 运行方式：cd frontend && npm run test:work-store
 */
import {
  EMPTY_WORK_STATE,
  workReducer,
  type WorkState
} from './store'

let pass = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? `（${detail}）` : ''}`)
    console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

const now = Date.now()

// ---------------------------------------------------------------- 基础一轮

let state: WorkState = workReducer(EMPTY_WORK_STATE, {
  type: 'mirror',
  event: { kind: 'user_message', localId: 'u1', text: '问题一', sentAt: now }
})
check('用户消息入列', state.messages.length === 1 && state.lastUserAt === now)

state = workReducer(state, {
  type: 'mirror',
  event: { kind: 'reply_start', messageId: 'm1' }
})
check('reply_start 建助手消息', state.streamingId === 'm1' && state.messages.length === 2)

state = workReducer(state, {
  type: 'mirror',
  event: { kind: 'reasoning', messageId: 'm1', text: '先想' }
})
state = workReducer(state, {
  type: 'mirror',
  event: { kind: 'token', messageId: 'm1', text: '答' }
})
const assistant = state.messages.find((m) => m.id === 'm1')
check('推理与正文分别累积', assistant?.reasoning === '先想' && assistant?.text === '答')
check('首个正文 token 定稿思考用时', typeof assistant?.thinkingMs === 'number')

state = workReducer(state, {
  type: 'mirror',
  event: { kind: 'reply_end', messageId: 'm1', fullText: '完整回答', interrupted: false }
})
check(
  'reply_end 用终稿覆盖并结束流式',
  state.streamingId === null && state.messages.find((m) => m.id === 'm1')?.text === '完整回答'
)

// ---------------------------------------------------------------- 中断 / 重复

state = workReducer(state, {
  type: 'mirror',
  event: { kind: 'reply_end', messageId: 'm2', fullText: '半截', interrupted: true }
})
check(
  '未收到 reply_start 也能按 reply_end 建消息并标记打断',
  state.messages.find((m) => m.id === 'm2')?.interrupted === true
)

const beforeDup = state.messages.length
state = workReducer(state, {
  type: 'mirror',
  event: { kind: 'user_message', localId: 'u1', text: '问题一', sentAt: now }
})
check('同一 localId 的用户消息不重复', state.messages.length === beforeDup)

// ---------------------------------------------------------------- 历史 + 缓冲 + live

const loaded = workReducer(EMPTY_WORK_STATE, {
  type: 'history',
  messages: [
    { id: 1, role: 'user', content: '历史问题' },
    { id: 2, role: 'assistant', content: '历史回答' }
  ],
  bufferedEvents: [
    { kind: 'user_message', localId: 'u2', text: '缓冲问题', sentAt: now },
    { kind: 'reply_start', messageId: 'm9' },
    { kind: 'token', messageId: 'm9', text: '部分' }
  ],
  live: { messageId: 'm9', text: '部分+续', reasoning: '推理', startedAt: now }
})
check('历史两条 + 缓冲用户 + 实时助手 = 4 条', loaded.messages.length === 4)
check('历史角色映射正确', loaded.messages[0].role === 'user' && loaded.messages[1].role === 'assistant')
const liveMsg = loaded.messages.find((m) => m.id === 'm9')
check('live 快照覆盖正文并带推理', liveMsg?.text === '部分+续' && liveMsg?.reasoning === '推理')
check('历史回填后仍在流式', loaded.streamingId === 'm9')

// ---------------------------------------------------------------- 提示 / 重置

const withWarning = workReducer(EMPTY_WORK_STATE, {
  type: 'mirror',
  event: { kind: 'notice', code: 'x', message: '注意', level: 'warn' }
})
check('warn 映射为 warning 样式', withWarning.notice?.kind === 'warn')

const withError = workReducer(EMPTY_WORK_STATE, {
  type: 'mirror',
  event: { kind: 'notice', code: 'x', message: '失败', level: 'error' }
})
check('error 映射为 error 样式', withError.notice?.kind === 'error')

const cleared = workReducer(withError, { type: 'clear-notice' })
check('clear-notice 清空提示', cleared.notice === null)

const reset = workReducer(loaded, { type: 'reset' })
check('reset 回到空态', reset.messages.length === 0 && reset.streamingId === null)

console.log(`\n=== work store 离线测试：${pass} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  failures.forEach((f) => console.error(`  ✗ ${f}`))
  process.exit(1)
}
