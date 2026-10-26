/** 请求 id：主进程按它配对回执（旧环境没有 randomUUID 时退化）。 */
export function makeRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
