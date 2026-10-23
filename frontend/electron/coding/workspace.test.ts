/**
 * coding/workspace 离线自测：
 *   npm run test:coding
 *
 * 覆盖：空/相对/UNC/非法字符、不存在、非目录、磁盘根、保护目录、正常目录。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateWorkspace } from './workspace'

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

/** 假 stat：只回答 isDirectory */
function fakeStat(isDir: boolean): fs.Stats {
  return { isDirectory: () => isDir } as unknown as fs.Stats
}

function main(): void {
  check('空路径/相对路径被拒绝', () => {
    assert.equal(validateWorkspace('').ok, false)
    assert.equal(validateWorkspace('demo/project').ok, false)
  })

  check('UNC 与非法字符被拒绝', () => {
    assert.equal(validateWorkspace('\\\\server\\share').ok, false)
    assert.equal(validateWorkspace('//server/share').ok, false)
    assert.equal(validateWorkspace(`D:\\a\0b`).ok, false)
  })

  check('不存在的路径被拒绝', () => {
    const result = validateWorkspace(path.join(os.tmpdir(), 'definitely-missing-xyz'), {
      realpath: () => {
        throw new Error('ENOENT')
      }
    })
    assert.equal(result.ok, false)
    assert.match((result as { message: string }).message, /不存在/)
  })

  check('文件（非目录）被拒绝', () => {
    const target = path.resolve(os.tmpdir(), 'some-file')
    const result = validateWorkspace(target, {
      realpath: () => target,
      stat: () => fakeStat(false)
    })
    assert.equal(result.ok, false)
    assert.match((result as { message: string }).message, /文件夹/)
  })

  check('磁盘根被拒绝', () => {
    const root = path.parse(process.cwd()).root
    const result = validateWorkspace(root, {
      realpath: () => root,
      stat: () => fakeStat(true)
    })
    assert.equal(result.ok, false)
    assert.match((result as { message: string }).message, /磁盘根目录/)
  })

  check('保护目录（含子目录）被拒绝', () => {
    const target = path.resolve(os.tmpdir(), 'pet-app', 'sub')
    const result = validateWorkspace(target, {
      realpath: () => target,
      stat: () => fakeStat(true),
      extraProtectedRoots: [
        { path: path.resolve(os.tmpdir(), 'pet-app'), descendants: true, reason: '这是小兔自己的目录' }
      ]
    })
    assert.equal(result.ok, false)
    assert.match((result as { message: string }).message, /小兔自己的目录/)
  })

  check('正常目录通过并返回真实路径', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-ws-'))
    try {
      const result = validateWorkspace(dir)
      assert.equal(result.ok, true)
      assert.equal((result as { path: string }).path, fs.realpathSync.native(dir))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log('workspace: all passed')
}

main()
