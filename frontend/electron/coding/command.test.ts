/**
 * coding/command 离线自测：
 *   npm run test:coding
 *
 * 覆盖：PATH 查找、版本判断、PY 覆盖、npx 回退、.cmd 的 shell 包装。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  findOnPath,
  parseVersion,
  resolveHarnessCommand,
  resolveNpxCommand,
  toSpawnSpec,
  versionAtLeast
} from './command'

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

const WIN = 'win32' as NodeJS.Platform
const LINUX = 'linux' as NodeJS.Platform

function existsFrom(set: Set<string>): (target: string) => boolean {
  return (target) => set.has(path.normalize(target))
}

function main(): void {
  check('版本解析与比较', () => {
    assert.deepEqual(parseVersion('0.2.1-rc.2'), [0, 2, 1])
    assert.equal(versionAtLeast('0.2.1-rc.2', '0.2.0'), true)
    assert.equal(versionAtLeast('0.1.1-rc.2', '0.2.0'), false)
    assert.equal(versionAtLeast('garbage', '0.2.0'), true)
  })

  check('findOnPath 按目录顺序命中', () => {
    const dirs = ['C:/a', 'C:/b']
    const found = findOnPath(
      ['dsh.cmd', 'dsh.exe'],
      dirs.join(path.delimiter),
      WIN,
      existsFrom(new Set([path.normalize('C:/b/dsh.exe')]))
    )
    assert.equal(found, path.join('C:/b', 'dsh.exe'))
  })

  check('PET_DSH_COMMAND 优先', () => {
    const command = resolveHarnessCommand({
      env: { PET_DSH_COMMAND: 'D:/tools/dsh.exe', PATH: '' },
      platform: WIN,
      pathValue: ''
    })
    assert.equal(command.source, 'custom')
    assert.equal(command.executable, 'D:/tools/dsh.exe')
  })

  check('PATH 上的新版 dsh 直接用', () => {
    const command = resolveHarnessCommand({
      env: {},
      platform: WIN,
      pathValue: 'C:/npm',
      fileExists: existsFrom(new Set([path.normalize('C:/npm/dsh.cmd')])),
      probeVersion: () => '0.2.1-rc.2'
    })
    assert.equal(command.source, 'path')
    assert.match(command.executable, /dsh\.cmd$/)
  })

  check('应用内 runtime 优先于 PATH', () => {
    const runtime = path.normalize(
      'C:/Local/ai-desktop-pet/dsh-runtime/node_modules/.bin/dsh.cmd'
    )
    const command = resolveHarnessCommand({
      env: {},
      platform: WIN,
      pathValue: 'C:/npm',
      fileExists: existsFrom(
        new Set([runtime, path.normalize('C:/npm/dsh.cmd')])
      ),
      probeVersion: () => '0.2.1',
      appRuntime: runtime
    })
    assert.equal(command.source, 'app')
    assert.equal(command.executable, runtime)
  })

  check('旧版 dsh 回退 npx', () => {
    const command = resolveHarnessCommand({
      env: {},
      platform: WIN,
      pathValue: 'C:/npm',
      fileExists: existsFrom(
        new Set([
          path.normalize('C:/npm/dsh.cmd'),
          path.normalize('C:/npm/npx.cmd')
        ])
      ),
      probeVersion: () => '0.1.1-rc.2'
    })
    assert.equal(command.source, 'npx')
    assert.deepEqual(command.baseArgs.slice(0, 1), ['-y'])
    assert.match(command.baseArgs[1], /@deepseek-ai\/dsh@/)
  })

  check('旧版且没有 npx 时报可操作错误', () => {
    assert.throws(
      () =>
        resolveHarnessCommand({
          env: {},
          platform: WIN,
          pathValue: 'C:/npm',
          fileExists: existsFrom(new Set([path.normalize('C:/npm/dsh.cmd')])),
          probeVersion: () => '0.1.1'
        }),
      /升级/
    )
  })

  check('都没有时报安装提示', () => {
    assert.throws(
      () =>
        resolveHarnessCommand({
          env: {},
          platform: LINUX,
          pathValue: '/usr/bin',
          fileExists: () => false
        }),
      /没找到 DeepSeek Harness/
    )
  })

  check('resolveNpxCommand 只找 npx', () => {
    const npx = resolveNpxCommand({
      env: {},
      platform: LINUX,
      pathValue: '/usr/bin',
      fileExists: (target) => target === path.normalize('/usr/bin/npx')
    })
    assert.ok(npx)
    assert.equal(npx?.source, 'npx')
  })

  check('Windows .cmd 走 cmd.exe，.exe 不用', () => {
    const bat = toSpawnSpec('C:/npm/dsh.cmd', ['--profile', 'acp'], WIN)
    assert.equal(bat.shell, false)
    assert.match(bat.command, /cmd\.exe$/i)
    assert.deepEqual(bat.args.slice(0, 3), ['/d', '/s', '/c'])
    assert.match(bat.args[3], /--profile acp/)

    const exe = toSpawnSpec('C:/tools/dsh.exe', ['--profile', 'acp'], WIN)
    assert.equal(exe.shell, false)
    assert.deepEqual(exe.args, ['--profile', 'acp'])

    const posix = toSpawnSpec('/usr/local/bin/dsh', ['--profile', 'acp'], LINUX)
    assert.equal(posix.shell, false)
  })

  console.log('command: all passed')
}

main()
