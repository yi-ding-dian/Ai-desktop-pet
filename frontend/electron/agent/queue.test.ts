/** 并发队列纯逻辑离线自测：npm run test:agent */
import assert from 'node:assert/strict'
import { findRunnableIndex, type QueueItem } from './queue'

function item(sessionId: string, workspace: string, enqueuedAt = 0): QueueItem {
  return { sessionId, workspace, kind: 'start', enqueuedAt }
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

function main(): void {
  check('不同工作区：按队首顺序取', () => {
    const queue = [item('a', 'w1', 1), item('b', 'w2', 2)]
    assert.equal(findRunnableIndex(queue, new Set()), 0)
  })

  check('队首工作区被占用：跳过它，先跑后面可运行的', () => {
    const queue = [item('a', 'w1', 1), item('b', 'w2', 2)]
    assert.equal(findRunnableIndex(queue, new Set(['w1'])), 1)
  })

  check('全部工作区被占用：返回 -1', () => {
    const queue = [item('a', 'w1', 1), item('b', 'w2', 2)]
    assert.equal(findRunnableIndex(queue, new Set(['w1', 'w2'])), -1)
  })

  check('空队列：返回 -1', () => {
    assert.equal(findRunnableIndex([], new Set()), -1)
  })

  console.log('queue.test 全部通过')
}

main()
