/**
 * bash 命令风险启发式（2026-10-24）。
 *
 * 用途：确认卡标红（任何模式）+ 自动模式决定“哪些命令仍要确认”。
 * **这不是沙箱**：字符串拼接、变量、脚本、base64 编码都可能绕过；
 * 自动模式只做尽力而为的拦截，界面上要明确提示。
 */

export interface CommandRisk {
  /** 命中致命/系统级操作 */
  dangerous: boolean
  /** 命中的风险标签（展示用） */
  labels: string[]
  /** 递归扫描类命令：只提示“可能很慢”，不算危险 */
  slow: boolean
}

const SLOW_SCAN_PATTERN = /-Recurse\b|dir\s+\/s\b|du\s+-[a-z]*s\b|find\s+\/\s/i

/** 致命/系统级命令 */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)*\/(\s|$)/i, label: '删除根目录' },
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)*~(\s|$)/i, label: '删除用户目录' },
  { re: /\bformat\s+[a-z]:/i, label: '格式化磁盘' },
  { re: /\b(diskpart|bcdedit|bootrec)\b/i, label: '磁盘/引导操作' },
  { re: /\b(mkfs|dd\s+[^|]*\bof=)/i, label: '写入磁盘/设备' },
  { re: /\b(shutdown|reboot|Restart-Computer|Stop-Computer)\b/i, label: '关机/重启' },
  { re: /\b(del|rd|rmdir)\s+[a-z]:[\\/]?(\s|$)/i, label: '删除盘符根' },
  { re: /\bgit\s+reset\s+--hard\b/i, label: '丢弃全部本地修改' },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, label: '删除未跟踪文件' },
  { re: /\bdel\s+\/[sf]\b/i, label: '强制删除' },
  { re: /\bRemove-Item\b.*-Recurse/i, label: '递归删除（PowerShell）' },
  { re: /\breg(\.exe)?\s+(add|delete|import|restore)\b/i, label: '修改注册表' },
  { re: /\bsc(\.exe)?\s+(create|delete|config)\b/i, label: '修改系统服务' },
  { re: /\b(New-Service|Set-Service|Remove-Service)\b/i, label: '修改系统服务' },
  { re: /\bsystemctl\s+(enable|disable|mask|unmask)\b/i, label: '修改系统服务' },
  { re: /\b(pnputil\b.*add-driver|Dism\b.*Add-Driver)\b/i, label: '安装/卸载驱动' },
  { re: /\bschtasks\b.*\/(create|change|delete)\b/i, label: '修改计划任务' },
  { re: /\b(powershell|pwsh)\b.*\s-(e|enc|encodedcommand)\b/i, label: '编码命令（无法审查内容）' }
]

/** 受保护路径的特征串（与 system/path-safety.ts 的口径一致，命中后再看有没有写/删动作） */
const PROTECTED_HINT = new RegExp(
  [
    'system32',
    '\\\\windows\\b',
    'program files',
    'programdata',
    '\\/etc\\/',
    '\\/usr\\/',
    '\\/bin\\/',
    '\\/sbin\\/',
    '\\/boot\\/',
    '\\/dev\\/'
  ].join('|'),
  'i'
)

/** 写/删类动词：只有同时命中受保护路径时才判危险，避免把 `ls C:\\Windows` 误伤 */
const WRITE_VERB = /\b(rm|del|rd|rmdir|mv|move|copy|cp|tee|truncate|chmod|chown|Remove-Item|Set-Content|Out-File|New-Item|copy-item|move-item)\b|>{1,2}/i

export function classifyBashCommand(command: string): CommandRisk {
  const text = command ?? ''
  const labels = DANGEROUS_PATTERNS.filter((item) => item.re.test(text)).map(
    (item) => item.label
  )
  if (PROTECTED_HINT.test(text) && WRITE_VERB.test(text)) {
    labels.push('写入/删除系统目录')
  }
  return {
    dangerous: labels.length > 0,
    labels: Array.from(new Set(labels)),
    slow: SLOW_SCAN_PATTERN.test(text)
  }
}
