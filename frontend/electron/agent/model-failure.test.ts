/**
 * 模型失败检测离线自测（npm run test:agent-model-failure）。
 */
import { lastAssistantFailure } from './model-failure'

let pass = 0
const failures: string[] = []
function check(name: string, ok: boolean): void {
  if (ok) pass += 1
  else failures.push(name)
}

// 最后一条 assistant 标记 error：返回错误文案
check(
  '识别 stopReason=error',
  lastAssistantFailure([
    { role: 'user', content: '你好' },
    { role: 'assistant', stopReason: 'error', errorMessage: '401: Authentication Fails' }
  ]) === '401: Authentication Fails'
)

// 正常结束：不算失败
check(
  'stop=stop 不算失败',
  lastAssistantFailure([
    { role: 'user', content: '你好' },
    { role: 'assistant', stopReason: 'stop' }
  ]) === null
)

// error 但没有原因：给兜底文案
check(
  'error 无原因时给兜底文案',
  lastAssistantFailure([{ role: 'assistant', stopReason: 'error' }]) !== null
)

// 历史轮次失败、最后一轮成功：不能误报
check(
  '只看最后一条 assistant',
  lastAssistantFailure([
    { role: 'assistant', stopReason: 'error', errorMessage: '401: 旧的失败' },
    { role: 'user', content: '重试' },
    { role: 'assistant', stopReason: 'stop' }
  ]) === null
)

// 末尾只有 user（请求未返回）：不算失败
check(
  '末尾无 assistant 不算失败',
  lastAssistantFailure([{ role: 'user', content: '你好' }]) === null
)
check('空消息不算失败', lastAssistantFailure([]) === null)

console.log(`\n=== agent model-failure 离线测试：${pass} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  failures.forEach((failure) => console.error(`  ✗ ${failure}`))
  process.exit(1)
}
