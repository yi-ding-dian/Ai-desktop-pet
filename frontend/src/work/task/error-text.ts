/** 把 IPC 错误还原成可直接展示的文案（去掉 Electron 的 remote method 前缀）。 */
export function errorText(err: unknown): string {
  const raw = (err as Error)?.message ?? String(err)
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
