/**
 * 任务恢复集成自测（离线，不连后端、不联网）：npm run test:agent-restore
 *
 * 覆盖 service 与 transcript/store 的接线：
 *  - 索引 + transcript 都在：重启后任务可继续（resumable），追问会尝试重建 Agent；
 *  - 只有索引、没有 transcript：保持回看但不可续聊；
 *  - 删除任务：对应 transcript 一起删除。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((err) => {
      console.error(`FAIL - ${name}`)
      throw err
    })
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pet-restore-'))
  process.env.PET_TEST_USER_DATA = dir
  // 只有 import 成功后才赋值；finally 里按可能为空处理
  let agentService!: (typeof import('./service'))['agentService']
  try {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace, { recursive: true })
    const now = Date.now()
    writeFileSync(
      join(dir, 'agent-sessions.json'),
      JSON.stringify({
        activeId: 'seeded',
        sessions: [
          {
            id: 'seeded',
            task: '重启后继续',
            workspace,
            createdAt: now - 1000,
            updatedAt: now,
            status: 'running',
            steps: [
              { id: 'round-1', kind: 'round', title: '接着聊', status: 'done', startedAt: 1 },
              { id: 'thinking-1', kind: 'thinking', turn: 1, title: '思考', status: 'done', startedAt: 2 }
            ],
            attachmentPaths: [join(dir, 'a.pdf')]
          },
          {
            id: 'legacy',
            task: '旧记录没有 transcript',
            workspace,
            createdAt: now - 2000,
            updatedAt: now - 1000,
            status: 'done',
            steps: []
          }
        ]
      }),
      'utf8'
    )
    mkdirSync(join(dir, 'agent-transcripts'), { recursive: true })
    const transcript = join(dir, 'agent-transcripts', 'seeded.json')
    writeFileSync(
      transcript,
      JSON.stringify({
        version: 1,
        messages: [
          { role: 'system', content: '旧提示', timestamp: 1 },
          { role: 'user', content: [{ type: 'text', text: '旧问题' }], timestamp: 2 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '旧回答' }],
            timestamp: 3
          }
        ]
      }),
      'utf8'
    )

    // 静态 import 会先于 env 求值，必须在设置目录后动态加载
    agentService = (await import('./service')).agentService

    await check('重启恢复：有 transcript 的任务可继续', () => {
      const state = agentService.getState()
      assert.equal(state.id, 'seeded')
      assert.equal(state.status, 'cancelled')
      assert.equal(state.resumable, true)
      assert.equal(state.steps.length, 2)
    })

    await check('重启恢复：按 transcript 重建的上下文里有旧消息', async () => {
      const { backendManager } = await import('../backend-process')
      const manager = backendManager as unknown as {
        internalToken?: string
        port?: number
        state?: string
      }
      manager.internalToken = 'test-token'
      manager.port = 9
      manager.state = 'ready'
      const realFetch = globalThis.fetch
      // 只替身「取 Key」这一步，buildAgent 本身不联网
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            configured: true,
            key: 'test-key',
            baseUrl: '',
            model: 'deepseek-chat'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )) as typeof fetch
      try {
        const service = agentService as unknown as {
          sessions: Map<
            string,
            { agent: { state: { messages: Array<{ role: string }> } } | null }
          >
          attachAgent: (session: unknown) => Promise<{ ok: boolean; error?: string }>
        }
        const session = service.sessions.get('seeded')
        assert.ok(session)
        const result = await service.attachAgent(session)
        assert.equal(result.ok, true, result.error)
        const roles = session.agent?.state.messages.map((message) => message.role) ?? []
        assert.equal(roles[0], 'system')
        assert.deepEqual(roles.slice(1), ['user', 'assistant'])
        // 清掉已挂载的 Agent，下一步继续走「没有 Agent → 尝试恢复」
        session.agent = null
      } finally {
        globalThis.fetch = realFetch
        manager.internalToken = undefined
        manager.port = undefined
        manager.state = 'starting'
      }
    })

    await check('重启恢复：追问会尝试重建 Agent（不是「上下文已释放」）', async () => {
      const result = await agentService.followUp({ text: '继续' })
      assert.equal(result.ok, false)
      assert.ok(result.error)
      assert.equal(result.error?.includes('上下文已释放'), false, result.error)
    })

    await check('没有 transcript 的旧任务：只能回看', () => {
      assert.equal(agentService.select('legacy').ok, true)
      assert.equal(agentService.getState().resumable, false)
    })

    await check('删除任务会删掉对应 transcript', () => {
      assert.equal(agentService.select('seeded').ok, true)
      assert.equal(agentService.deleteTask('seeded').ok, true)
      assert.equal(existsSync(transcript), false)
    })
  } finally {
    // 清掉防抖落盘定时器，避免测试目录删掉后它又把目录写回来
    const timer = (agentService as unknown as { saveTimer?: NodeJS.Timeout } | null)?.saveTimer
    if (timer) clearTimeout(timer)
    rmSync(dir, { recursive: true, force: true })
  }
}

await main()
