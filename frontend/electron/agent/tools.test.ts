/**
 * 任务工具离线自测（node 直接运行，不需要 Electron）：
 *   npm run test:agent
 *
 * 覆盖：工具清单、读/写/改/搜/列/待办的行为与上限、bash 环境清洗、
 * 危险命令识别、确认卡内容。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  createTools,
  describeToolCall,
  needsApproval,
  runCommand
} from './tools'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-tools-')))
fs.mkdirSync(path.join(root, 'src'))
fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'line1\nline2\nline3\n')
fs.writeFileSync(path.join(root, 'notes.md'), '# 标题\n登录模块 TODO\n')

const todos: Array<{ text: string; status: string }> = []
const tools = createTools({ workspace: root, onTodo: (items) => todos.push(...items) })
const byName = new Map<string, AgentTool>(tools.map((tool) => [tool.name, tool]))

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((err) => {
      console.error(`FAIL - ${name}`)
      throw err
    })
}

async function run(toolName: string, params: unknown): Promise<string> {
  const tool = byName.get(toolName)
  assert.ok(tool, `工具不存在：${toolName}`)
  const result = await tool.execute('test', params, undefined, undefined)
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

async function main(): Promise<void> {
  await check('工具清单齐全且审批分类正确', () => {
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['bash', 'cleanup_candidates', 'disk_usage', 'edit_file', 'list_files', 'read_file', 'search_text', 'todo', 'write_file'].sort()
    )
    assert.equal(needsApproval('read_file'), false)
    assert.equal(needsApproval('search_text'), false)
    assert.equal(needsApproval('todo'), false)
    assert.equal(needsApproval('write_file'), true)
    assert.equal(needsApproval('edit_file'), true)
    assert.equal(needsApproval('bash'), true)
    assert.equal(needsApproval('disk_usage'), false)
    assert.equal(needsApproval('cleanup_candidates'), false)
  })

  await check('list_files 列目录并跳过隐藏目录', async () => {
    fs.mkdirSync(path.join(root, 'node_modules'))
    const text = await run('list_files', { path: '.' })
    assert.match(text, /src\//)
    assert.match(text, /notes\.md/)
    assert.doesNotMatch(text, /node_modules/)
  })

  await check('read_file 返回带行号内容，支持 offset/limit', async () => {
    const text = await run('read_file', { path: 'src/a.ts', offset: 2, limit: 1 })
    assert.match(text, /2\| line2/)
    assert.doesNotMatch(text, /line1/)
  })

  await check('read_file 越界路径拒绝', async () => {
    await assert.rejects(() => run('read_file', { path: '../secret.txt' }))
  })

  await check('search_text 命中文件与行号', async () => {
    const text = await run('search_text', { query: '登录' })
    assert.match(text, /notes\.md:2:/)
  })

  await check('disk_usage 只读列出磁盘与目录占用', async () => {
    const drives = await run('disk_usage', {})
    assert.match(drives, /总 /)
    const dir = await run('disk_usage', { path: '.' })
    assert.match(dir, /合计/)
    assert.match(dir, /src\//)
  })

  await check('cleanup_candidates 只读统计且不删除', async () => {
    const text = await run('cleanup_candidates', {})
    assert.match(text, /可清理位置合计/)
    assert.match(text, /未删除/)
  })

  await check('write_file 新建与覆盖', async () => {
    await run('write_file', { path: 'src/new.ts', content: 'export const n = 1\n' })
    assert.equal(fs.readFileSync(path.join(root, 'src', 'new.ts'), 'utf8'), 'export const n = 1\n')
    await run('write_file', { path: 'src/new.ts', content: 'export const n = 2\n' })
    assert.equal(fs.readFileSync(path.join(root, 'src', 'new.ts'), 'utf8'), 'export const n = 2\n')
  })

  await check('edit_file 唯一命中替换 / 不唯一与未命中报错', async () => {
    const text = await run('edit_file', {
      path: 'src/new.ts',
      old_string: 'n = 2',
      new_string: 'n = 3'
    })
    assert.match(text, /替换 1 处/)
    assert.match(fs.readFileSync(path.join(root, 'src', 'new.ts'), 'utf8'), /n = 3/)

    fs.writeFileSync(path.join(root, 'dup.txt'), 'aaa\naaa\n')
    await assert.rejects(
      () => run('edit_file', { path: 'dup.txt', old_string: 'aaa', new_string: 'b' }),
      /不唯一/
    )
    await assert.rejects(
      () => run('edit_file', { path: 'dup.txt', old_string: 'zzz', new_string: 'b' }),
      /没有找到/
    )
  })

  await check('todo 更新待办清单', async () => {
    await run('todo', { items: [{ text: '读代码', status: 'done' }, { text: '改代码', status: 'pending' }] })
    assert.deepEqual(todos, [
      { text: '读代码', status: 'done' },
      { text: '改代码', status: 'pending' }
    ])
  })

  await check('bash 正常执行并返回输出', async () => {
    const text = await run('bash', { command: 'node -e "console.log(1+1)"' })
    assert.equal(text.trim(), '2')
  })

  await check('bash 中文输出不乱码（GBK 自动识别）', async () => {
    const text = await run('bash', { command: 'echo 你好' })
    assert.equal(text.trim(), '你好')
  })

  await check('bash 非零退出码报错', async () => {
    await assert.rejects(() => run('bash', { command: 'node -e "process.exit(3)"' }), /退出码 3/)
  })

  await check('bash 不把 Key 传给子进程', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-should-not-leak'
    try {
      const text = await run('bash', {
        command: 'node -e "console.log(process.env.DEEPSEEK_API_KEY || \'none\')"'
      })
      assert.equal(text.trim(), 'none')
    } finally {
      delete process.env.DEEPSEEK_API_KEY
    }
  })

  await check('bash 超时终止', async () => {
    const result = await runCommand('node -e "setTimeout(()=>{}, 60000)"', root, 800)
    assert.equal(result.timedOut, true)
  })

  await check('确认卡：危险命令标红', () => {
    const desc = describeToolCall('bash', { command: 'rm -rf /' }, root)
    assert.equal(desc.dangerous, true)
    assert.match(desc.preview ?? '', /危险操作/)
    const safe = describeToolCall('bash', { command: 'npm test' }, root)
    assert.equal(safe.dangerous, false)
  })

  await check('确认卡：递归扫描提示可能很慢', () => {
    const desc = describeToolCall('bash', { command: 'Get-ChildItem C:/ -Recurse' }, root)
    assert.match(desc.preview ?? '', /很慢/)
  })

  await check('确认卡：写文件带 diff 预览', () => {
    const desc = describeToolCall(
      'write_file',
      { path: 'src/a.ts', content: 'line1\nline2 changed\nline3\n' },
      root
    )
    assert.match(desc.title.replace(/\\/g, '/'), /src\/a\.ts/)
    assert.match(desc.preview ?? '', /- line2/)
    assert.match(desc.preview ?? '', /\+ line2 changed/)
  })

  await check('确认卡：编辑文件展示 -/+ 行', () => {
    const desc = describeToolCall(
      'edit_file',
      { path: 'src/a.ts', old_string: 'old', new_string: 'new' },
      root
    )
    assert.match(desc.preview ?? '', /- old/)
    assert.match(desc.preview ?? '', /\+ new/)
  })

  fs.rmSync(root, { recursive: true, force: true })
  console.log('tools.test 全部通过')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
