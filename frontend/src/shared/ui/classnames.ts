/** 条件拼接 className（套件内部用；避免为一行工具函数引入依赖）。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
