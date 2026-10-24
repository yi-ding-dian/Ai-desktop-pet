/**
 * 轻量 glob 匹配（2026-10-24）：任务工具的 `pattern / include` 用。
 *
 * 支持 `**`（跨目录）、`*`（单层）、`?`（单字符）；不引入新依赖。
 * - 带 `/` 的 pattern 匹配相对路径，否则只匹配文件名；
 * - 统一大小写不敏感（Windows 友好，Linux 上略宽松）；
 * - 不支持 `[]` 字符类，`[` 会按字面量处理。
 */
export function matchGlob(pattern: string, relPath: string): boolean {
  const raw = (pattern ?? '').trim()
  if (!raw) return true
  const normalized = raw.replace(/\\/g, '/')
  const targetPath = (relPath ?? '').replace(/\\/g, '/')
  const target = normalized.includes('/')
    ? targetPath
    : (targetPath.split('/').pop() ?? targetPath)
  return globToRegExp(normalized).test(target)
}

function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1
        if (pattern[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += '\\^$+?.()|{}[]'.includes(ch) ? `\\${ch}` : ch
  }
  return new RegExp(`^${out}$`, 'i')
}
