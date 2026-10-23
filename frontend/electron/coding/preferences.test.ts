/**
 * coding/preferences 离线自测：
 *   npm run test:coding
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CODING_PREFERENCES,
  loadCodingPreferences,
  saveCodingPreferences
} from './preferences'

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
  check('默认复用宠物 Key', () => {
    assert.equal(DEFAULT_CODING_PREFERENCES.reuseLlmKey, true)
  })

  check('文件不存在时回退默认值', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-coding-prefs-'))
    try {
      const prefs = loadCodingPreferences(path.join(dir, 'missing.json'))
      assert.deepEqual(prefs, { reuseLlmKey: true })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  check('写入后可读回', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-coding-prefs-'))
    const file = path.join(dir, 'coding-preferences.json')
    try {
      saveCodingPreferences(file, { reuseLlmKey: false })
      assert.deepEqual(loadCodingPreferences(file), { reuseLlmKey: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  check('文件损坏时回退默认值', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-coding-prefs-'))
    const file = path.join(dir, 'coding-preferences.json')
    try {
      fs.writeFileSync(file, '{not json', 'utf8')
      assert.deepEqual(loadCodingPreferences(file), { reuseLlmKey: true })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log('preferences: all passed')
}

main()
