/**
 * 任务附件拼装离线自测（node 直接运行）：图片本地、文档走后端端点、失败给出可读提示。
 *   npm run test:agent
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPrompt } from './attachments'
import type { AgentAttachment } from './types'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pet-agent-attach-')))
const pdfPath = path.join(root, 'report.pdf')
const textPath = path.join(root, 'notes.txt')
fs.writeFileSync(pdfPath, 'stub')
fs.writeFileSync(textPath, 'hello note\n')

const pdfAttachment: AgentAttachment = { path: pdfPath, name: 'report.pdf', kind: 'other' }
const textAttachment: AgentAttachment = { path: textPath, name: 'notes.txt', kind: 'text' }

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
  await check('文档调内部端点，文本本地内联', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const prompt = await buildPrompt('看看', [pdfAttachment, textAttachment], async (endpoint, body) => {
      calls.push({ path: endpoint, body })
      return {
        ok: true,
        files: [
          {
            name: 'report.pdf',
            text: '— 第 1 页 —\nPDF 正文',
            chars: 12,
            imageUrl: null,
            mime: null
          }
        ]
      }
    })

    assert.match(prompt.text, /PDF 正文/)
    assert.match(prompt.text, /hello note/)
    assert.deepEqual(calls, [{ path: '/internal/files/extract', body: { paths: [pdfPath] } }])
  })

  await check('文档读取失败给出可读提示，不抛异常', async () => {
    const prompt = await buildPrompt('看看', [pdfAttachment], async () => ({
      ok: false,
      message: '有密码保护'
    }))
    assert.match(prompt.text, /report\.pdf 读取失败：有密码保护/)
  })

  await check('没有后端时文档走"读不了"提示', async () => {
    const prompt = await buildPrompt('看看', [pdfAttachment])
    assert.match(prompt.text, /PDF\/Office 文档，当前环境读不了内容/)
    assert.match(prompt.text, /看看/)
  })

  fs.rmSync(root, { recursive: true, force: true })
  console.log('attachments.test 全部通过')
}

void main()
