/**
 * 磁盘清理白名单离线自测（node 直接运行，不需要 Electron）：
 *   npm run test:clean-paths
 *
 * 覆盖：key 白名单、浏览器/缩略图路径解析、占用统计、搬入暂存目录与搬回。
 * 不调用 shell.trashItem（那一步在主进程 IPC 里）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  formatBytes,
  measureCleanTargets,
  resolveCleanTargets,
  restoreStaged,
  stageCleanTarget,
  type CleanTarget
} from './clean-paths'

function check(name: string, fn: () => void | Promise<void>): void {
  const run = async (): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (err) {
      console.error(`FAIL - ${name}`)
      throw err
    }
  }
  pending.push(run())
}

const pending: Array<Promise<void>> = []

function touch(file: string, size: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'x'.repeat(size))
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-clean-'))
const local = path.join(root, 'Local')
const temp = path.join(root, 'Temp')
const profile = path.join(root, 'User')
const explorer = path.join(local, 'Microsoft', 'Windows', 'Explorer')
const chromeCache = path.join(
  local,
  'Google',
  'Chrome',
  'User Data',
  'Default',
  'Cache'
)
const env = {
  LOCALAPPDATA: local,
  TEMP: temp,
  TMP: temp,
  USERPROFILE: profile
}

touch(path.join(temp, 'a.tmp'), 10)
touch(path.join(chromeCache, 'b.bin'), 20)
touch(path.join(explorer, 'thumbcache_1.db'), 7)
touch(path.join(explorer, 'other.bin'), 100)

check('未知 key 拒绝', () => {
  const result = resolveCleanTargets(['nope'], { env, platform: 'win32' })
  assert.equal(result.ok, false)
})

check('Windows 白名单解析：temp / Chrome / 缩略图', () => {
  const result = resolveCleanTargets(
    ['user_temp', 'chrome_cache', 'thumbnails'],
    { env, platform: 'win32' }
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  const byKey = new Map(result.targets.map((target) => [target.key, target]))
  assert.equal(byKey.get('user_temp')?.paths[0], fs.realpathSync.native(temp))
  assert.equal(
    byKey.get('chrome_cache')?.paths[0],
    fs.realpathSync.native(chromeCache)
  )
  assert.deepEqual(
    byKey.get('thumbnails')?.paths.map((item) => path.basename(item)),
    ['thumbcache_1.db']
  )
  assert.equal(byKey.get('thumbnails')?.kind, 'files')
})

check('浏览器缓存不存在时整体拒绝（不部分执行）', () => {
  const result = resolveCleanTargets(['user_temp', 'edge_cache'], {
    env,
    platform: 'win32'
  })
  assert.equal(result.ok, false)
})

check('占用统计', () => {
  const resolved = resolveCleanTargets(['user_temp', 'thumbnails'], {
    env,
    platform: 'win32'
  })
  assert.equal(resolved.ok, true)
  if (!resolved.ok) return
  const measured = measureCleanTargets(resolved.targets)
  assert.equal(measured.totalBytes, 17)
  assert.equal(measured.totalFiles, 2)
})

check('搬入暂存目录后可以搬回', async () => {
  const target: CleanTarget = {
    key: 'user_temp',
    label: '用户临时文件',
    kind: 'dir_contents',
    paths: [fs.realpathSync.native(temp)]
  }
  const staged = await stageCleanTarget(target)
  assert.equal(staged.moved, 1)
  assert.equal(staged.skipped, 0)
  assert.equal(staged.movedBytes, 10)
  assert.equal(fs.readdirSync(temp).length, 0)
  assert.equal(staged.stages.length, 1)
  assert.equal(fs.readdirSync(staged.stages[0].dir).includes('a.tmp'), true)

  await restoreStaged(staged.stages)
  assert.equal(fs.existsSync(path.join(temp, 'a.tmp')), true)
  assert.equal(fs.existsSync(staged.stages[0].dir), false)
})

check('字节格式化', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1024 ** 3), '1.0 GB')
})

void Promise.all(pending)
  .then(() => {
    fs.rmSync(root, { recursive: true, force: true })
    console.log('clean-paths.test: all passed')
  })
  .catch((err) => {
    console.error(err)
    fs.rmSync(root, { recursive: true, force: true })
    process.exit(1)
  })
