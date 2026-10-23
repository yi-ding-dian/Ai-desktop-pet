/**
 * coding/runtime 离线自测：
 *   npm run test:coding
 *
 * 覆盖：平台数据目录、runtime 路径、四种探测状态、优先级。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  codingDataHome,
  codingHarnessHome,
  codingRuntimeDir,
  codingRuntimeExecutable,
  detectCodingRuntime
} from './runtime'

const WIN = 'win32' as NodeJS.Platform
const LINUX = 'linux' as NodeJS.Platform

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

function existsFrom(set: Set<string>): (target: string) => boolean {
  return (target) => set.has(path.normalize(target))
}

function main(): void {
  check('Windows 数据目录用 LOCALAPPDATA（不走 Roaming）', () => {
    const home = codingDataHome({ LOCALAPPDATA: 'C:/Users/me/AppData/Local' }, WIN)
    assert.equal(home, path.normalize('C:/Users/me/AppData/Local'))
    const dir = codingRuntimeDir({ LOCALAPPDATA: 'C:/Users/me/AppData/Local' }, WIN)
    assert.ok(dir.endsWith(path.join('ai-desktop-pet', 'dsh-runtime')))
  })

  check('Linux 数据目录用 XDG_DATA_HOME', () => {
    const home = codingDataHome({ XDG_DATA_HOME: '/home/me/.local/share' }, LINUX)
    assert.equal(home, path.normalize('/home/me/.local/share'))
  })

  check('隔离 Harness Home 在应用数据目录下', () => {
    const home = codingHarnessHome({ LOCALAPPDATA: 'C:/Local' }, WIN)
    assert.ok(home.endsWith(path.join('ai-desktop-pet', 'dsh-home')))
    assert.ok(home.startsWith(path.normalize('C:/Local')))
  })

  check('可执行文件路径按平台区分', () => {
    assert.match(codingRuntimeExecutable('/data/dsh-runtime', WIN), /dsh\.cmd$/)
    assert.match(codingRuntimeExecutable('/data/dsh-runtime', LINUX), /dsh$/)
  })

  check('应用内 runtime 就绪', () => {
    const env = { LOCALAPPDATA: 'C:/Local' }
    const exe = codingRuntimeExecutable(codingRuntimeDir(env, WIN), WIN)
    const status = detectCodingRuntime({
      env,
      platform: WIN,
      pathValue: '',
      fileExists: existsFrom(new Set([path.normalize(exe)])),
      probeVersion: () => '0.2.1-rc.2'
    })
    assert.equal(status.state, 'ready')
    assert.equal(status.source, 'app')
    assert.equal(status.runtimeInstalled, true)
  })

  check('应用内 runtime 版本过旧', () => {
    const env = { LOCALAPPDATA: 'C:/Local' }
    const exe = codingRuntimeExecutable(codingRuntimeDir(env, WIN), WIN)
    const status = detectCodingRuntime({
      env,
      platform: WIN,
      pathValue: '',
      fileExists: existsFrom(new Set([path.normalize(exe)])),
      probeVersion: () => '0.1.1'
    })
    assert.equal(status.state, 'outdated')
    assert.equal(status.source, 'app')
  })

  check('系统 PATH 上的新版可用', () => {
    const status = detectCodingRuntime({
      env: { LOCALAPPDATA: 'C:/Local' },
      platform: WIN,
      pathValue: 'C:/npm',
      fileExists: existsFrom(new Set([path.normalize('C:/npm/dsh.cmd')])),
      probeVersion: () => '0.2.1'
    })
    assert.equal(status.state, 'ready')
    assert.equal(status.source, 'path')
  })

  check('系统 PATH 旧版标记过旧', () => {
    const status = detectCodingRuntime({
      env: { LOCALAPPDATA: 'C:/Local' },
      platform: WIN,
      pathValue: 'C:/npm',
      fileExists: existsFrom(new Set([path.normalize('C:/npm/dsh.cmd')])),
      probeVersion: () => '0.1.1-rc.2'
    })
    assert.equal(status.state, 'outdated')
    assert.equal(status.source, 'path')
  })

  check('只有 npx 时标记 npx-only', () => {
    const status = detectCodingRuntime({
      env: { LOCALAPPDATA: 'C:/Local' },
      platform: WIN,
      pathValue: 'C:/npm',
      fileExists: existsFrom(
        new Set([path.normalize('C:/npm/npx.cmd'), path.normalize('C:/npm/npm.cmd')])
      )
    })
    assert.equal(status.state, 'npx-only')
    assert.equal(status.npxAvailable, true)
    assert.equal(status.npmAvailable, true)
  })

  check('什么都没有时不可用', () => {
    const status = detectCodingRuntime({
      env: { LOCALAPPDATA: 'C:/Local' },
      platform: WIN,
      pathValue: 'C:/empty',
      fileExists: () => false
    })
    assert.equal(status.state, 'unavailable')
    assert.equal(status.npmAvailable, false)
    assert.equal(status.npxAvailable, false)
  })

  console.log('runtime: all passed')
}

main()
