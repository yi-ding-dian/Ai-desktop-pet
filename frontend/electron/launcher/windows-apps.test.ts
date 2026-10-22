/**
 * launcher/windows-apps 离线自测（node 直接运行，不需要 Electron）：
 *   npm run test:launcher
 *
 * 覆盖：`.lnk` 头/LinkInfo/相对路径解析、参数拆分、开始菜单根、扫描与按名匹配。
 * 用内存里拼出来的最小 Shell Link 样本，不依赖 Windows。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findApplications } from './application-scan'
import {
  clearWindowsAppCache,
  expandWindowsEnv,
  parseShellLink,
  scanWindowsApplications,
  splitWindowsArguments,
  startMenuRoots
} from './windows-apps'

const CLSID = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x46
])

const HAS_TARGET_ID_LIST = 0x1
const HAS_LINK_INFO = 0x2
const HAS_RELATIVE_PATH = 0x8
const HAS_WORKING_DIR = 0x10
const HAS_ARGUMENTS = 0x20
const IS_UNICODE = 0x80
const HAS_EXP_STRING = 0x200

function utf16(value: string): Buffer {
  return Buffer.from(value, 'utf16le')
}

function stringData(value: string): Buffer {
  const head = Buffer.alloc(2)
  head.writeUInt16LE(value.length, 0)
  return Buffer.concat([head, utf16(value)])
}

interface LinkOptions {
  target?: string
  relativePath?: string
  workingDir?: string
  args?: string
  /** 只有 IDList 的快捷方式：目录 + 文件名 */
  idList?: { dirs: string[]; file: string }
  /** ExtraData 里的环境变量目标（`%windir%\...`） */
  envTarget?: string
}

/** 文件系统 shell item（FileEntry：FileSize/FileTime/Attributes + 保留字节 + ANSI 名） */
function fileEntryItem(type: number, name: string): Buffer {
  const nameBytes = Buffer.from(`${name}\0`, 'latin1')
  const head = Buffer.alloc(14)
  head.writeUInt16LE(14 + nameBytes.length, 0)
  head[2] = type
  head.writeUInt16LE(0x10, 12)
  return Buffer.concat([head, nameBytes])
}

function shellItem(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(3)
  head.writeUInt16LE(3 + data.length, 0)
  head[2] = type
  return Buffer.concat([head, data])
}

/** 盘符根 + 各级目录 + 文件，末尾带 IDList 终止符 */
function buildIdList(dirs: string[], file: string): Buffer {
  const root = Buffer.from('1f50e04fd020ea3a6910a2d808002b30309d', 'hex')
  const items = [
    shellItem(0x1f, root),
    shellItem(0x2f, Buffer.from('C:\\\0', 'latin1')),
    ...dirs.map((dir) => fileEntryItem(0x31, dir)),
    fileEntryItem(0x32, file)
  ]
  const body = Buffer.concat([...items, Buffer.alloc(2)])
  const head = Buffer.alloc(2)
  head.writeUInt16LE(body.length, 0)
  return Buffer.concat([head, body])
}

/** ExtraData 的 EnvironmentVariableDataBlock */
function environmentBlock(target: string): Buffer {
  const block = Buffer.alloc(0x314)
  block.writeUInt32LE(0x314, 0)
  block.writeUInt32LE(0xa0000001, 4)
  block.write(target, 8, 'latin1')
  block.write(target, 8 + 260, 'utf16le')
  return block
}

/** 拼一个最小可解析的 .lnk（LinkInfo 走 Unicode 偏移） */
function buildLink(options: LinkOptions): Buffer {
  let flags = IS_UNICODE
  if (options.idList) flags |= HAS_TARGET_ID_LIST
  if (options.target) flags |= HAS_LINK_INFO
  if (options.relativePath) flags |= HAS_RELATIVE_PATH
  if (options.workingDir) flags |= HAS_WORKING_DIR
  if (options.args) flags |= HAS_ARGUMENTS
  if (options.envTarget) flags |= HAS_EXP_STRING

  const header = Buffer.alloc(0x4c)
  header.writeUInt32LE(0x4c, 0)
  CLSID.copy(header, 4)
  header.writeUInt32LE(flags, 20)
  header.writeUInt32LE(0x20, 24)
  header.writeUInt32LE(1, 60)

  const parts: Buffer[] = [header]
  if (options.idList) {
    parts.push(buildIdList(options.idList.dirs, options.idList.file))
  }
  if (options.target) {
    const base = Buffer.concat([utf16(options.target), Buffer.alloc(2)])
    const suffix = Buffer.alloc(2)
    const size = 0x24 + base.length + suffix.length
    const info = Buffer.alloc(0x24)
    info.writeUInt32LE(size, 0)
    info.writeUInt32LE(0x24, 4)
    info.writeUInt32LE(1, 8)
    info.writeUInt32LE(0, 12)
    info.writeUInt32LE(0, 16)
    info.writeUInt32LE(0, 20)
    info.writeUInt32LE(0, 24)
    info.writeUInt32LE(0x24, 28)
    info.writeUInt32LE(0x24 + base.length, 32)
    parts.push(info, base, suffix)
  }
  if (options.relativePath) parts.push(stringData(options.relativePath))
  if (options.workingDir) parts.push(stringData(options.workingDir))
  if (options.args) parts.push(stringData(options.args))
  if (options.envTarget) parts.push(environmentBlock(options.envTarget))
  return Buffer.concat(parts)
}

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

check('LinkInfo：目标、参数、工作目录', () => {
  const link = parseShellLink(
    buildLink({
      target: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
      workingDir: 'C:\\Program Files\\Tencent\\WeChat',
      args: '--from-shortcut "D:\\My Data"'
    }),
    'C:\\Users\\me\\Desktop\\微信.lnk'
  )
  assert.ok(link)
  assert.equal(link.target, 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe')
  assert.deepEqual(link.args, ['--from-shortcut', 'D:\\My Data'])
  assert.equal(link.workingDir, 'C:\\Program Files\\Tencent\\WeChat')
})

check('没有 LinkInfo 时回退 RelativePath（相对 .lnk 所在目录）', () => {
  const linkPath = 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\App\\App.lnk'
  const relative = '..\\..\\App\\App.exe'
  const link = parseShellLink(buildLink({ relativePath: relative }), linkPath)
  assert.ok(link)
  assert.equal(
    link.target,
    path.win32.resolve(path.win32.dirname(linkPath), relative)
  )
})

check('只有 IDList 的快捷方式（系统工具类）还原路径', () => {
  const link = parseShellLink(
    buildLink({ idList: { dirs: ['Windows', 'System32'], file: 'taskmgr.exe' } })
  )
  assert.ok(link)
  assert.equal(link.target, 'C:\\Windows\\System32\\taskmgr.exe')

  // 名字里出现路径分隔/上级目录：拒绝，不拼出根外路径
  assert.equal(
    parseShellLink(buildLink({ idList: { dirs: ['..'], file: 'evil.exe' } })),
    null
  )
})

check('ExtraData 环境变量块（%windir% 目标）', () => {
  const link = parseShellLink(
    buildLink({ envTarget: '%windir%\\system32\\notepad.exe' }),
    '',
    { windir: 'C:\\Windows' }
  )
  assert.ok(link)
  assert.equal(link.target, 'C:\\Windows\\system32\\notepad.exe')
})

check('目标里的 %VAR% 展开 + 缺目标返回 null', () => {
  const link = parseShellLink(
    buildLink({ target: '%ProgramFiles%\\App\\App.exe' }),
    '',
    { ProgramFiles: 'D:\\Apps' }
  )
  assert.ok(link)
  assert.equal(link.target, 'D:\\Apps\\App\\App.exe')

  assert.equal(parseShellLink(Buffer.alloc(8)), null)
  assert.equal(parseShellLink(Buffer.concat([Buffer.alloc(0x4c)])), null)
  assert.equal(parseShellLink(buildLink({ workingDir: 'C:\\tmp' })), null)
})

check('命令行参数拆分', () => {
  assert.deepEqual(splitWindowsArguments('--a  b'), ['--a', 'b'])
  assert.deepEqual(splitWindowsArguments('"a b" c'), ['a b', 'c'])
  assert.deepEqual(splitWindowsArguments('""'), [''])
  assert.deepEqual(splitWindowsArguments('a\\b'), ['a\\b'])
  assert.deepEqual(splitWindowsArguments('"C:\\Program Files\\App\\\\"'), [
    'C:\\Program Files\\App\\'
  ])
})

check('环境变量展开（大小写不敏感、未知变量原样保留）', () => {
  assert.equal(
    expandWindowsEnv('%programfiles%\\App', { ProgramFiles: 'D:\\Apps' }),
    'D:\\Apps\\App'
  )
  assert.equal(expandWindowsEnv('%NOPE%\\x', {}), '%NOPE%\\x')
})

check('开始菜单根：当前用户优先，其次 ProgramData', () => {
  const roots = startMenuRoots({
    APPDATA: path.win32.join('C:', 'Users', 'me', 'AppData', 'Roaming'),
    ProgramData: path.win32.join('C:', 'ProgramData')
  })
  assert.deepEqual(roots, [
    path.win32.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.win32.join('C:', 'ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ])
})

// 真实文件系统扫描只在 Windows 上有意义（开始菜单根由 %APPDATA% 拼成 Windows 路径）
if (process.platform !== 'win32') {
  console.log('skip - 扫描开始菜单（需要 Windows 文件系统）')
} else check('扫描开始菜单并按名字匹配', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-win-apps-'))
  const appData = path.join(tmp, 'AppData')
  const programs = path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs'
  )
  const installDir = path.join(tmp, 'Program Files', 'WeChat')
  fs.mkdirSync(path.join(programs, 'Tencent'), { recursive: true })
  fs.mkdirSync(installDir, { recursive: true })
  const exe = path.join(installDir, 'WeChat.exe')
  fs.writeFileSync(exe, 'dummy')
  fs.writeFileSync(
    path.join(programs, 'Tencent', '微信.lnk'),
    buildLink({ target: exe, workingDir: installDir })
  )

  clearWindowsAppCache()
  const apps = scanWindowsApplications({
    env: { APPDATA: appData },
    now: 1
  })
  assert.equal(apps.length, 1)
  assert.equal(apps[0].name, '微信')
  assert.equal(apps[0].execPath, exe)
  assert.equal(apps[0].available, true)
  assert.equal(apps[0].workingDir, installDir)

  const byName = findApplications(apps, '微信')
  assert.equal(byName.match?.execPath, exe)
  const byExe = findApplications(apps, 'WeChat')
  assert.equal(byExe.match?.execPath, exe)

  clearWindowsAppCache()
  console.log('windows-apps.test: all passed')
})
