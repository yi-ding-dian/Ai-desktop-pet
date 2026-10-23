/**
 * coding/acp 集成自测（不需要 Electron、不需要真实 dsh）：
 *   npm run test:coding
 *
 * 用临时目录里的 fake ACP 子进程跑通：
 *   initialize → session/new → session/prompt → 更新 → 权限请求 → 正常结束 → dispose
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AcpSession, parsePermissionRequest, pickAllowOption } from './acp'

const FAKE_SERVER = String.raw`
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
let promptId = null
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const update = (value) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: value } })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    return out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake', version: '0.0.0' }, agentCapabilities: {}, authMethods: [] } })
  }
  if (msg.method === 'session/new') {
    return out({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's-1' } })
  }
  if (msg.method === 'session/prompt') {
    promptId = msg.id
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的' } })
    update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '写文件', kind: 'edit', status: 'in_progress', rawInput: { path: 'a.ts' } })
    out({ jsonrpc: '2.0', id: 100, method: 'session/request_permission', params: {
      sessionId: 's-1',
      toolCall: { toolCallId: 't1', title: '写文件', kind: 'edit', rawInput: { path: 'a.ts' } },
      options: [
        { optionId: 'allow', name: '允许一次', kind: 'allow_once' },
        { optionId: 'deny', name: '拒绝', kind: 'reject_once' }
      ]
    } })
    return
  }
  if (msg.method === 'session/close') {
    return out({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
  if (msg.id === 100) {
    const selected = msg.result && msg.result.outcome && msg.result.outcome.optionId
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: selected === 'allow' ? 'completed' : 'failed' })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: selected === 'allow' ? '完成' : '被拒绝' } })
    out({ jsonrpc: '2.0', id: promptId, result: { stopReason: selected === 'allow' ? 'end_turn' : 'refusal' } })
  }
})
`

async function withFakeServer(fn: (script: string, cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-acp-'))
  const script = path.join(dir, 'fake-acp.cjs')
  fs.writeFileSync(script, FAKE_SERVER, 'utf8')
  try {
    await fn(script, dir)
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 子进程可能还占着文件——留给系统清理
    }
  }
}

async function main(): Promise<void> {
  {
    const parsed = parsePermissionRequest({
      sessionId: 's',
      toolCall: { toolCallId: 't', title: '跑命令', kind: 'execute', rawInput: { command: 'npm test' } },
      options: [
        { optionId: 'a', name: '允许', kind: 'allow_once' },
        { optionId: 'b', name: '总是允许', kind: 'allow_always' }
      ]
    })
    assert.equal(parsed.title, '跑命令')
    assert.match(parsed.detail, /npm test/)
    assert.equal(pickAllowOption(parsed.options)?.optionId, 'a')
    assert.equal(pickAllowOption(parsed.options)?.kind, 'allow_once')
    // 没有 allow_once 时不允许（不会退化成 allow_always）
    assert.equal(pickAllowOption([{ optionId: 'x', name: 'x', kind: 'allow_always' }]), null)
    console.log('ok - 权限请求解析与一次性允许选择')
  }

  await withFakeServer(async (script, cwd) => {
    const updates: Array<Record<string, unknown>> = []
    let permissionAsked = 0
    const session = await AcpSession.start({
      executable: process.execPath,
      baseArgs: [script],
      cwd,
      onUpdate: (update) => updates.push(update),
      onPermission: async (request) => {
        permissionAsked += 1
        assert.equal(request.title, '写文件')
        assert.equal(request.kind, 'edit')
        assert.match(request.detail, /a\.ts/)
        assert.ok(pickAllowOption(request.options))
        return 'allow'
      }
    })

    assert.equal(session.sessionId, 's-1')
    const result = await session.prompt('帮我改一下')
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(permissionAsked, 1)

    const kinds = updates.map((update) => update.sessionUpdate)
    assert.ok(kinds.includes('agent_message_chunk'))
    assert.ok(kinds.includes('tool_call'))
    assert.ok(kinds.includes('tool_call_update'))

    await session.dispose()
    console.log('ok - ACP 全链路（允许）')
  })

  await withFakeServer(async (script, cwd) => {
    const session = await AcpSession.start({
      executable: process.execPath,
      baseArgs: [script],
      cwd,
      onPermission: async () => 'reject'
    })
    const result = await session.prompt('帮我改一下')
    assert.equal(result.stopReason, 'refusal')
    await session.dispose()
    console.log('ok - ACP 权限拒绝后子进程收到 cancelled')
  })

  await withFakeServer(async (script, cwd) => {
    const session = await AcpSession.start({
      executable: process.execPath,
      baseArgs: [script],
      cwd
    })
    const startedAt = Date.now()
    await session.dispose()
    assert.ok(Date.now() - startedAt < 8_000, 'dispose 应在宽限内结束')
    console.log('ok - ACP dispose 回收进程')
  })

  console.log('acp: all passed')
}

void main()
