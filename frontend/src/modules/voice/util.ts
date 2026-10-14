/** voice 域内共享小工具 */

/** 归一化到 [0,1] */
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 日志用短 id（message_id 截断） */
export const shortId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id)
