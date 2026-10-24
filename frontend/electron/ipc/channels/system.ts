/** 打开外链/本机路径的结果（记忆本 open_item；失败 message 可直接展示） */
export interface OpenResult {
  ok: boolean
  message?: string
}

/**
 * 删除本机路径的结果：
 * - ``confirmed=false``：用户点了取消 / 点别处 / 气泡超时——什么都没删；
 * - ``confirmed=true, ok=false``：用户确认了，但删除失败（权限/路径变化等）。
 */
export interface DeletePathResult {
  confirmed: boolean
  ok: boolean
  message?: string
}

/** 删除真实文件的请求（path 必须是绝对路径；name 仅用于确认气泡文案） */
export interface DeletePathRequest {
  path: string
  name?: string
}

/**
 * 清理白名单缓存的结果（2026-10-22）：
 * - ``confirmed=false``：用户取消/超时——什么都没动；
 * - ``ok=true``：内容已移入回收站；``movedBytes`` 是搬走的量（**清空回收站后才真正释放**）；
 * - ``skipped``：被占用/无权限而跳过的条目数。
 */
export interface CleanDiskResult {
  confirmed: boolean
  ok: boolean
  movedBytes?: number
  moved?: number
  skipped?: number
  message?: string
}
