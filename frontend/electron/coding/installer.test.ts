/**
 * coding/installer 离线自测：
 *   npm run test:coding
 *
 * 不跑真实 npm 下载；覆盖安装参数与卸载的目录边界。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildInstallArgs, uninstallHarness } from './installer'
import { codingRuntimeDir } from './runtime'

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

function main(): void {
  check('安装参数：--prefix 指向应用目录且版本锁定', () => {
    const args = buildInstallArgs('/data/ai-desktop-pet/dsh-runtime')
    assert.deepEqual(args.slice(0, 4), ['install', '--prefix', '/data/ai-desktop-pet/dsh-runtime', '--no-audit'])
    assert.match(args[args.length - 1], /^@deepseek-ai\/dsh@\d+\.\d+\.\d+/)
  })

  check('卸载只删应用自己的 runtime 目录', () => {
    const platform = process.platform
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-dsh-home-'))
    const env =
      platform === 'win32' ? { LOCALAPPDATA: home } : { XDG_DATA_HOME: home }
    const dir = codingRuntimeDir(env, platform)
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'dsh.cmd'), 'fake', 'utf8')

    try {
      const result = uninstallHarness({ env, platform })
      assert.equal(result.ok, true)
      assert.equal(fs.existsSync(dir), false)
      // 数据目录本身保留
      assert.equal(fs.existsSync(home), true)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  check('没有安装时卸载给出提示', () => {
    const platform = process.platform
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-dsh-home-'))
    const env =
      platform === 'win32' ? { LOCALAPPDATA: home } : { XDG_DATA_HOME: home }
    try {
      const result = uninstallHarness({ env, platform })
      assert.equal(result.ok, false)
      assert.match(result.message, /没有找到/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  console.log('installer: all passed')
}

main()
