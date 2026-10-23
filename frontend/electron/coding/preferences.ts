/**
 * 编码代理偏好（2026-10-23）。
 *
 * 只存"是否复用宠物 LLM Key"这类非敏感开关；Key 本身绝不落盘，
 * 启动任务时现取现用（后端 → 主进程内存 → 子进程环境变量）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CodingPreferences } from '../ipc/channels'

export type { CodingPreferences } from '../ipc/channels'

export const DEFAULT_CODING_PREFERENCES: CodingPreferences = {
  reuseLlmKey: true
}

/** 偏好文件名（放在 Electron userData 下） */
export function codingPreferencesFile(userData: string): string {
  return path.join(userData, 'coding-preferences.json')
}

/** 读取偏好：文件不存在/损坏都回退默认值，不让设置页打不开 */
export function loadCodingPreferences(file: string): CodingPreferences {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(raw) as Record<string, unknown>
    return {
      reuseLlmKey:
        typeof data.reuseLlmKey === 'boolean'
          ? data.reuseLlmKey
          : DEFAULT_CODING_PREFERENCES.reuseLlmKey
    }
  } catch {
    return { ...DEFAULT_CODING_PREFERENCES }
  }
}

/** 写入偏好（原子替换，避免写一半损坏） */
export function saveCodingPreferences(
  file: string,
  preferences: CodingPreferences
): CodingPreferences {
  const normalized: CodingPreferences = {
    reuseLlmKey: Boolean(preferences.reuseLlmKey)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return normalized
}
