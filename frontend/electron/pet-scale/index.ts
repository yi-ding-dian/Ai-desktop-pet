/**
 * 宠物缩放档位（2026-10-21）：运行时值的来源、持久化与变更通知。
 *
 * 为什么主进程自己存一份：宠物窗在后端配置就绪之前就要创建（main.ts），主进程读不到
 * 后端 `pet.scale`；因此设置窗保存时经 IPC 通知主进程，主进程写入 `userData/pet-scale.json`，
 * 下次启动建窗前直接读取。后端 `pet.scale` 仍是配置的"真相源"，两者由设置面同时写。
 *
 * 档位常量与尺寸公式在 window/index.ts（petWindowSize），本模块只管"当前是哪一档"。
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPetScale, type PetScale } from '../window'

/** 当前档位（建窗前由 initPetScale 读取；默认 1.0） */
let current: PetScale = 1.0

/** 持久化文件路径（userData；app ready 后可用） */
function storePath(): string {
  return join(app.getPath('userData'), 'pet-scale.json')
}

/**
 * 读取持久化档位（app ready 后、创建宠物窗口前调用）。
 * 文件缺失/损坏/不是支持档位时回落 1.0（不抛错）。
 */
export function initPetScale(): PetScale {
  try {
    const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as { scale?: unknown }
    if (isPetScale(raw?.scale)) current = raw.scale
  } catch {
    // 首次运行/文件损坏：保持默认 1.0
  }
  console.log(`[pet-scale] 启动档位 ${current}x`)
  return current
}

/** 当前档位 */
export function getPetScale(): PetScale {
  return current
}

/** 写入并更新当前档位（调用方负责应用窗口尺寸与广播） */
export function savePetScale(scale: PetScale): void {
  current = scale
  try {
    writeFileSync(storePath(), JSON.stringify({ scale }), 'utf8')
  } catch (err) {
    console.warn('[pet-scale] 持久化失败（本次会话仍生效）：', err)
  }
}
