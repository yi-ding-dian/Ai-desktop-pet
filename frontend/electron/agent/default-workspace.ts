/**
 * 任务模式默认工作区（2026-10-25）。
 *
 * 规则（与产品讨论对齐）：
 *  - config.toml `[agent].default_workspace` 非空 → 只认它；目录不存在/不是文件夹
 *    直接抛可读错误，**不静默换目录**；
 *  - 配置为空 → 平台默认（用户文档/ai-desktop-pet），不存在就创建；
 *  - 后端不可达 → 直接抛错（任务模式本来也要后端才能跑，不拿别的目录顶上）；
 *  - 配置损坏（configError）→ 报"配置无效"，由用户去设置里重选。
 *
 * 平台路径换算只在 `platform/`（本文件只注入 documents/home）。
 */
import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { callInternal, callInternalGet } from './internal-api'
import {
  DEFAULT_WORKSPACE_DIR_NAME,
  defaultWorkspaceBase,
  type DefaultWorkspaceHost
} from '../platform'
import { resolveWorkspace } from './workspace'

/** 取系统目录：Electron 在部分 Linux 环境没有 documents，用家目录兜底。 */
function hostPaths(): DefaultWorkspaceHost {
  let documents = ''
  let home = ''
  try {
    documents = app.getPath('documents')
  } catch {
    documents = ''
  }
  try {
    home = app.getPath('home')
  } catch {
    home = ''
  }
  return { documents, home }
}

/**
 * 读取配置里的默认工作区。
 *
 * - 后端不可达 → 直接抛错（任务模式本来也要后端才能跑，不能拿别的目录顶上）；
 * - 后端明确说配置坏了（configError）→ 标记 invalid，由调用方报错，不静默换目录。
 */
async function configuredWorkspace(): Promise<{ value: string; invalid: boolean }> {
  const result = await callInternalGet('/internal/agent-config')
  if (result.configError) return { value: '', invalid: true }
  return { value: (result.defaultWorkspace ?? '').trim(), invalid: false }
}

/** 平台默认工作区的绝对路径（只计算，不创建目录）；系统目录都取不到时返回空串。 */
export function platformDefaultWorkspacePath(): string {
  const base = defaultWorkspaceBase(hostPaths())
  return base ? join(base, DEFAULT_WORKSPACE_DIR_NAME) : ''
}

/**
 * 解析本次任务使用的工作区（realpath）。
 *
 * 配置值无效时抛错，让任务页显示原因并让用户重选——不自动回退。
 */
export async function resolveDefaultWorkspace(): Promise<string> {
  const configured = await configuredWorkspace()
  if (configured.invalid) {
    throw new Error('默认工作区配置无效，请到「设置 → 任务」重新选择')
  }
  if (configured.value) return resolveWorkspace(configured.value)

  const fallback = platformDefaultWorkspacePath()
  if (!fallback) throw new Error('找不到用户文档目录，请手动选择工作区')
  if (!existsSync(fallback)) {
    try {
      mkdirSync(fallback, { recursive: true })
    } catch {
      throw new Error(`默认工作区创建失败：${fallback}`)
    }
  }
  return resolveWorkspace(fallback)
}

/** 把目录写回 config.toml（任务页「设为默认」/设置页保存）。 */
export async function saveDefaultWorkspace(
  path: string
): Promise<{ ok: boolean; error?: string }> {
  const text = (path ?? '').trim()
  try {
    const result = await callInternal('/internal/agent-config', { defaultWorkspace: text })
    if (!result.ok) return { ok: false, error: result.message || '保存默认工作区失败' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
