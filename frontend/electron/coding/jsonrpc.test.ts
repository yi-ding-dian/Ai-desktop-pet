/**
 * coding/jsonrpc 离线自测：
 *   npm run test:coding
 *
 * 覆盖：请求/响应配对、错误响应、通知、双向请求、超时、关闭后在途请求。
 */
import assert from 'node:assert/strict'
import { JsonRpcCallError, JsonRpcConnection } from './jsonrpc'

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (err) {
      console.error(`FAIL - ${name}`)
      throw err
    }
  }
  return run()
}

async function main(): Promise<void> {
  await check('请求带自增 id 与方法参数', async () => {
    const lines: string[] = []
    const rpc = new JsonRpcConnection({ write: (line) => lines.push(line) })
    const pending = rpc.request('initialize', { protocolVersion: 1 })
    const sent = JSON.parse(lines[0]) as Record<string, unknown>
    assert.equal(sent.jsonrpc, '2.0')
    assert.equal(sent.id, 1)
    assert.equal(sent.method, 'initialize')
    assert.deepEqual(sent.params, { protocolVersion: 1 })
    // 不留下 30s 定时器：直接关闭并吞掉在途请求的拒绝
    rpc.dispose(new Error('test done'))
    await pending.catch(() => undefined)
  })

  await check('响应按 id 解析并 resolve', async () => {
    const lines: string[] = []
    const rpc = new JsonRpcConnection({ write: (line) => lines.push(line) })
    const pending = rpc.request('session/new', { cwd: 'D:/x' })
    rpc.accept(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sessionId: 's1' } }))
    assert.deepEqual(await pending, { sessionId: 's1' })
  })

  await check('错误响应 reject 为 JsonRpcCallError', async () => {
    const rpc = new JsonRpcConnection({ write: () => {} })
    const pending = rpc.request('session/prompt', {})
    rpc.accept(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, message: 'boom' }
      })
    )
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof JsonRpcCallError)
      assert.equal(err.code, -32603)
      assert.match(err.message, /boom/)
      return true
    })
  })

  await check('通知进入 onNotification', async () => {
    const seen: Array<{ method: string; params: unknown }> = []
    const rpc = new JsonRpcConnection(
      { write: () => {} },
      {
        onNotification: (method, params) => {
          seen.push({ method, params })
        }
      }
    )
    rpc.accept(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk' } }
      })
    )
    assert.equal(seen.length, 1)
    assert.equal(seen[0].method, 'session/update')
  })

  await check('对方请求被处理并回写 result', async () => {
    const lines: string[] = []
    const rpc = new JsonRpcConnection(
      { write: (line) => lines.push(line) },
      {
        onRequest: async (method, params) => {
          assert.equal(method, 'session/request_permission')
          assert.deepEqual(params, { sessionId: 's1' })
          return { outcome: { outcome: 'cancelled' } }
        }
      }
    )
    rpc.accept(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: { sessionId: 's1' }
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(lines.length, 1)
    const reply = JSON.parse(lines[0]) as Record<string, unknown>
    assert.equal(reply.id, 7)
    assert.deepEqual(reply.result, { outcome: { outcome: 'cancelled' } })
  })

  await check('未注册的对方请求回 -32601', async () => {
    const lines: string[] = []
    const rpc = new JsonRpcConnection({ write: (line) => lines.push(line) })
    rpc.accept(
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'fs/read_text_file', params: {} })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const reply = JSON.parse(lines[0]) as { error?: { code?: number } }
    assert.equal(reply.error?.code, -32601)
  })

  await check('请求超时会 reject', async () => {
    const rpc = new JsonRpcConnection({ write: () => {} }, {}, 20)
    await assert.rejects(rpc.request('slow'), /超时/)
  })

  await check('dispose 拒绝所有在途请求', async () => {
    const rpc = new JsonRpcConnection({ write: () => {} })
    const pending = rpc.request('session/prompt', {})
    rpc.dispose(new Error('进程退出'))
    await assert.rejects(pending, /进程退出/)
    assert.equal(rpc.isClosed, true)
  })

  await check('非 JSON 行不抛异常，走 onError', async () => {
    const errors: string[] = []
    const rpc = new JsonRpcConnection(
      { write: () => {} },
      { onError: (err) => errors.push(err.message) }
    )
    rpc.accept('not json')
    assert.equal(errors.length, 1)
    assert.match(errors[0], /非 JSON/)
  })

  console.log('jsonrpc: all passed')
}

void main()
