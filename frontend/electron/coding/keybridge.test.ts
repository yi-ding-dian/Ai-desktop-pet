/**
 * coding/keybridge 离线自测：
 *   npm run test:coding
 *
 * 用假 fetch 验证：请求头、成功/失败/未配置/网络异常都返回正确结果。
 */
import assert from 'node:assert/strict'
import { INTERNAL_KEY_PATH, isDeepSeekBaseUrl, requestLlmKey } from './keybridge'

function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  return (async () => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (err) {
      console.error(`FAIL - ${name}`)
      throw err
    }
  })()
}

function fakeResponse(ok: boolean, body: unknown): Response {
  return {
    ok,
    status: ok ? 200 : 403,
    json: async () => body
  } as unknown as Response
}

async function main(): Promise<void> {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return fakeResponse(true, { configured: true, key: 'sk-test-123456', baseUrl: 'https://api.deepseek.com/v1' })
  }) as unknown as typeof fetch

  await check('成功时带回 Key 与鉴权头', async () => {
    calls.length = 0
    const key = await requestLlmKey({
      baseUrl: 'http://127.0.0.1:1234',
      token: 'tok',
      fetchImpl: fakeFetch
    })
    assert.deepEqual(key, { key: 'sk-test-123456', baseUrl: 'https://api.deepseek.com/v1' })
    assert.equal(calls[0].url, `http://127.0.0.1:1234${INTERNAL_KEY_PATH}`)
    const headers = calls[0].init?.headers as Record<string, string>
    assert.equal(headers['X-Pet-Internal-Token'], 'tok')
  })

  await check('configured=false 返回 null', async () => {
    const key = await requestLlmKey({
      baseUrl: 'http://127.0.0.1:1234',
      token: 'tok',
      fetchImpl: (async () => fakeResponse(true, { configured: false, baseUrl: '' })) as unknown as typeof fetch
    })
    assert.equal(key, null)
  })

  await check('403 返回 null', async () => {
    const key = await requestLlmKey({
      baseUrl: 'http://127.0.0.1:1234',
      token: 'wrong',
      fetchImpl: (async () => fakeResponse(false, {})) as unknown as typeof fetch
    })
    assert.equal(key, null)
  })

  await check('网络异常返回 null', async () => {
    const key = await requestLlmKey({
      baseUrl: 'http://127.0.0.1:1',
      token: 'tok',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch
    })
    assert.equal(key, null)
  })

  await check('空 Key 返回 null', async () => {
    const key = await requestLlmKey({
      baseUrl: 'http://127.0.0.1:1234',
      token: 'tok',
      fetchImpl: (async () =>
        fakeResponse(true, { configured: true, key: '   ', baseUrl: 'https://api.deepseek.com' })) as unknown as typeof fetch
    })
    assert.equal(key, null)
  })

  await check('只认 DeepSeek 官方域名', async () => {
    assert.equal(isDeepSeekBaseUrl('https://api.deepseek.com/v1'), true)
    assert.equal(isDeepSeekBaseUrl('https://deepseek.com/anthropic'), true)
    assert.equal(isDeepSeekBaseUrl('https://api.moonshot.cn/v1'), false)
    assert.equal(isDeepSeekBaseUrl('not a url'), false)
    assert.equal(isDeepSeekBaseUrl(''), false)
  })

  console.log('keybridge: all passed')
}

void main()
