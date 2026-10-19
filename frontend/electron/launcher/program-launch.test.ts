/**
 * launcher/program-launch 离线自测（node 直接运行，不需要 Electron）：
 *   npm run test:launcher
 *
 * 覆盖：可执行文件校验（存在/普通文件/执行位/目录/.desktop/shell basename/
 * 特殊目录/相对路径）与工作目录回退。不实际启动进程。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isShellBasename,
  resolveWorkingDirectory,
  spawnDetached,
  validateLaunchableProgram
} from './program-launch'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-launcher-'))

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

function makeFile(name: string, mode: number): string {
  const file = path.join(tmpDir, name)
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(file, mode)
  return file
}

check('可执行普通文件通过校验并返回 realpath', () => {
  const file = makeFile('app', 0o755)
  const result = validateLaunchableProgram(file)
  assert.equal(result.ok, true)
  assert.equal(result.path, fs.realpathSync(file))
})

check('非字符串 / 空 / 相对路径拒绝', () => {
  assert.equal(validateLaunchableProgram(null).code, 'launcher_invalid_path')
  assert.equal(validateLaunchableProgram('').code, 'launcher_invalid_path')
  assert.equal(validateLaunchableProgram('./app').code, 'launcher_invalid_path')
  assert.equal(validateLaunchableProgram('C:\\app.exe').ok, false)
})

check('不存在的路径拒绝', () => {
  const result = validateLaunchableProgram(path.join(tmpDir, 'missing'))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'launcher_invalid_path')
})

check('没有执行位的文件拒绝', () => {
  const file = makeFile('plain', 0o644)
  const result = validateLaunchableProgram(file)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'launcher_not_executable')
  assert.match(result.message || '', /执行权限/)
})

check('文件夹拒绝', () => {
  const folder = path.join(tmpDir, 'folder')
  fs.mkdirSync(folder)
  const result = validateLaunchableProgram(folder)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'launcher_not_regular_file')
})

check('.desktop 与 shell 本体拒绝', () => {
  const desktop = makeFile('app.desktop', 0o755)
  assert.equal(validateLaunchableProgram(desktop).ok, false)

  const bash = makeFile('bash', 0o755)
  const result = validateLaunchableProgram(bash)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'launcher_unsafe_program')
  assert.equal(isShellBasename('/bin/zsh'), true)
  assert.equal(isShellBasename('/usr/bin/firefox'), false)
})

check('特殊文件系统路径拒绝', () => {
  const result = validateLaunchableProgram('/proc/self/exe')
  assert.equal(result.ok, false)
})

check('工作目录只接受存在的绝对目录，否则回退主目录', () => {
  assert.equal(resolveWorkingDirectory(tmpDir), tmpDir)
  assert.equal(resolveWorkingDirectory('relative/dir'), os.homedir())
  assert.equal(resolveWorkingDirectory(path.join(tmpDir, 'missing')), os.homedir())
  assert.equal(resolveWorkingDirectory(''), os.homedir())
})

async function asyncChecks(): Promise<void> {
  const result = await spawnDetached(path.join(tmpDir, 'missing'), [])
  assert.equal(result.ok, false)
  console.log('ok - spawnDetached 对非法路径直接返回失败（不会执行）')
  console.log('launch.test: all passed')
}

void asyncChecks().catch((err) => {
  console.error('FAIL - asyncChecks')
  console.error(err)
  process.exit(1)
})
