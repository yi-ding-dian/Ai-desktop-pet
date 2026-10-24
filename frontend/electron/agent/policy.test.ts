/**
 * 执行模式权限策略离线自测（node 直接运行，不需要 Electron）：
 *   npm run test:agent
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decideToolCall } from './policy'
import type { ExecutionMode } from './types'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-policy-')))
const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-policy-out-')))
const outsideFile = path.join(outsideDir, 'a.txt')

function decide(
  mode: ExecutionMode,
  toolName: string,
  args: unknown
): ReturnType<typeof decideToolCall> {
  return decideToolCall({ mode, toolName, args, workspace: root })
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

async function main(): Promise<void> {
  check('读类工具三模式都放行', () => {
    for (const mode of ['standard', 'auto', 'plan'] as ExecutionMode[]) {
      assert.deepEqual(decide(mode, 'read_file', { path: outsideFile }), { action: 'allow' })
      assert.deepEqual(decide(mode, 'search_text', { query: 'x' }), { action: 'allow' })
      assert.deepEqual(decide(mode, 'ask_user', { question: 'q', options: ['a', 'b'] }), {
        action: 'allow'
      })
    }
  })

  check('标准：工作区内写/改/删免确认', () => {
    assert.deepEqual(decide('standard', 'write_file', { path: 'a.txt', content: 'x' }), {
      action: 'allow'
    })
    assert.deepEqual(decide('standard', 'edit_file', { path: 'a.txt' }), { action: 'allow' })
    assert.deepEqual(decide('standard', 'delete_path', { path: 'a.txt' }), { action: 'allow' })
  })

  check('标准：工作区外写/删要确认', () => {
    assert.equal(decide('standard', 'write_file', { path: outsideFile }).action, 'confirm')
    assert.equal(decide('standard', 'edit_file', { path: outsideFile }).action, 'confirm')
    assert.equal(decide('standard', 'delete_path', { path: outsideFile }).action, 'confirm')
  })

  check('自动：工作区外写/删直接放行', () => {
    assert.deepEqual(decide('auto', 'write_file', { path: outsideFile }), { action: 'allow' })
    assert.deepEqual(decide('auto', 'delete_path', { path: outsideFile }), { action: 'allow' })
  })

  check('计划：写/改/删/命令一律拒绝', () => {
    for (const tool of ['write_file', 'edit_file', 'delete_path']) {
      assert.equal(decide('plan', tool, { path: 'a.txt' }).action, 'deny')
    }
    assert.equal(decide('plan', 'bash', { command: 'ls' }).action, 'deny')
  })

  check('bash：标准一律确认、自动只拦致命、计划拒绝', () => {
    assert.equal(decide('standard', 'bash', { command: 'ls' }).action, 'confirm')
    const safe = decide('auto', 'bash', { command: 'npm test' })
    assert.equal(safe.action, 'allow')
    const danger = decide('auto', 'bash', { command: 'format C:' })
    assert.equal(danger.action, 'confirm')
    assert.ok(danger.action === 'confirm' && danger.dangerous)
    assert.equal(decide('plan', 'bash', { command: 'npm test' }).action, 'deny')
  })

  check('系统目录：所有模式都拒绝', () => {
    const systemRoot = process.env.SystemRoot ?? process.env.windir ?? '/etc'
    const target = path.join(systemRoot, 'pet-policy-test.txt')
    for (const mode of ['standard', 'auto', 'plan'] as ExecutionMode[]) {
      assert.equal(decide(mode, 'write_file', { path: target }).action, 'deny')
    }
  })

  check('删除工作区根与包含工作区的上级目录：拒绝', () => {
    assert.equal(decide('auto', 'delete_path', { path: '.' }).action, 'deny')
    assert.equal(decide('auto', 'delete_path', { path: path.dirname(root) }).action, 'deny')
  })

  check('非法路径与未知工具：拒绝', () => {
    assert.equal(decide('standard', 'write_file', { path: '\\\\server\\share\\a' }).action, 'deny')
    assert.equal(decide('standard', 'write_file', { path: 'a\0b' }).action, 'deny')
    assert.equal(decide('standard', 'unknown_tool', {}).action, 'deny')
  })

  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outsideDir, { recursive: true, force: true })
  console.log('policy.test 全部通过')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
