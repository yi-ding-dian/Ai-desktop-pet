/**
 * workspace 离线自测（node 直接运行，不需要 Electron）：
 *   npm run test:agent
 *
 * 覆盖：工作区校验（相对路径/UNC/盘符根/不存在）、工作区内路径解析、
 * `..` 越界、绝对路径越界、尚不存在的新文件、符号链接逃逸。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveInsideWorkspace, resolveWorkspace, WorkspaceError } from './workspace'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-ws-')))
fs.mkdirSync(path.join(root, 'src'))
fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

function expectWorkspaceError(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => err instanceof WorkspaceError)
}

check('工作区：相对路径拒绝', () => {
  expectWorkspaceError(() => resolveWorkspace('src'))
})

check('工作区：UNC 拒绝', () => {
  expectWorkspaceError(() => resolveWorkspace('\\\\server\\share'))
})

check('工作区：不存在拒绝', () => {
  expectWorkspaceError(() => resolveWorkspace(path.join(root, 'nope')))
})

check('工作区：文件不是目录', () => {
  expectWorkspaceError(() => resolveWorkspace(path.join(root, 'src', 'a.ts')))
})

check('工作区：合法目录返回 realpath', () => {
  assert.equal(resolveWorkspace(root), root)
})

check('工作区：盘符根拒绝', () => {
  const driveRoot = path.parse(root).root
  expectWorkspaceError(() => resolveWorkspace(driveRoot))
})

check('路径：相对路径解析到工作区内', () => {
  assert.equal(resolveInsideWorkspace(root, 'src/a.ts'), path.join(root, 'src', 'a.ts'))
})

check('路径：绝对路径在工作区内放行', () => {
  assert.equal(
    resolveInsideWorkspace(root, path.join(root, 'src')),
    path.join(root, 'src')
  )
})

check('路径：.. 越界拒绝', () => {
  expectWorkspaceError(() => resolveInsideWorkspace(root, '../outside.txt'))
})

check('路径：绝对路径越界拒绝', () => {
  expectWorkspaceError(() => resolveInsideWorkspace(root, path.join(root, '..', 'x.txt')))
})

check('路径：尚不存在的新文件允许（父目录在工作区内）', () => {
  assert.equal(
    resolveInsideWorkspace(root, 'src/new/deep.ts'),
    path.join(root, 'src', 'new', 'deep.ts')
  )
})

check('路径：NUL 字符拒绝', () => {
  expectWorkspaceError(() => resolveInsideWorkspace(root, 'src/a\0b.ts'))
})

check('路径：符号链接逃逸拒绝（能建则测）', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-outside-'))
  const link = path.join(root, 'escape')
  try {
    fs.symlinkSync(outside, link, 'junction')
  } catch {
    console.log('  （当前环境无法创建符号链接，跳过）')
    return
  }
  expectWorkspaceError(() => resolveInsideWorkspace(root, 'escape/secret.txt'))
})

fs.rmSync(root, { recursive: true, force: true })
console.log('workspace.test 全部通过')
