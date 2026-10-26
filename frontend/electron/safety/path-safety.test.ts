/**
 * path-safety 离线自测（node 直接运行，不需要 Electron）：
 *   npm run test:path-safety
 *
 * 覆盖：URL 白名单、路径存在性、受保护目录（主目录/根/系统目录）、
 * 祖先保护、可执行文件拦截。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isDangerousExecutable,
  isSafeHttpUrl,
  protectedPathReason,
  resolveExistingPath
} from './path-safety'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-path-safety-'))

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

check('isSafeHttpUrl 只放行 http/https 且拒绝凭据', () => {
  assert.equal(isSafeHttpUrl('https://example.com/a'), true)
  assert.equal(isSafeHttpUrl('http://example.com'), true)
  assert.equal(isSafeHttpUrl('file:///etc/passwd'), false)
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false)
  assert.equal(isSafeHttpUrl('https://user:pass@example.com'), false)
  assert.equal(isSafeHttpUrl(''), false)
  assert.equal(isSafeHttpUrl(null), false)
})

check('resolveExistingPath 校验绝对路径与存在性', () => {
  const result = resolveExistingPath(tmpDir)
  assert.equal(result.isDir, true)
  assert.equal(path.resolve(result.path), path.resolve(tmpDir))
  assert.throws(() => resolveExistingPath('relative/path'))
  assert.throws(() => resolveExistingPath(path.join(tmpDir, 'definitely-missing')))
})

check('可执行/脚本扩展名与可执行位被拦截', () => {
  const exe = path.join(tmpDir, 'evil.EXE')
  fs.writeFileSync(exe, 'x')
  assert.equal(isDangerousExecutable(exe, false), true)

  const txt = path.join(tmpDir, 'note.txt')
  fs.writeFileSync(txt, 'x')
  assert.equal(isDangerousExecutable(txt, false), false)
  assert.equal(isDangerousExecutable(tmpDir, true), false)
})

check('根目录 / 用户主目录受保护，普通临时目录可删', () => {
  assert.ok(protectedPathReason(path.parse(process.cwd()).root))
  assert.ok(protectedPathReason(os.homedir()))
  assert.equal(protectedPathReason(tmpDir), null)
})

check('系统/应用目录内部受保护，祖先目录也受保护', () => {
  const extra = [{ path: tmpDir, descendants: true, reason: '测试保护目录' }]
  const inside = path.join(tmpDir, 'cache')
  fs.mkdirSync(inside, { recursive: true })
  assert.equal(protectedPathReason(inside, extra), '测试保护目录')
  assert.equal(protectedPathReason(tmpDir, extra), '测试保护目录')
  // 删除 tmpDir 的父目录会连同受保护目录一起带走 -> 拒绝
  assert.ok(protectedPathReason(path.dirname(tmpDir), extra))
})

fs.rmSync(tmpDir, { recursive: true, force: true })
console.log('path-safety: all checks passed')
