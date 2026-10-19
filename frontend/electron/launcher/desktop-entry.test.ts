/**
 * launcher/desktop-entry 离线自测（node 直接运行，不需要 Electron）：
 *   npm run test:launcher
 *
 * 覆盖：Exec 拆分、字段码剥离、[Desktop Entry] 解析、本地化 Name、
 * `env KEY=VALUE` 目标解析、PATH 查找。
 */
import assert from 'node:assert/strict'
import {
  execTargetIndex,
  localeCandidates,
  parseDesktopEntry,
  pickLocalized,
  resolveExecTarget,
  splitExec,
  stripFieldCodes
} from './desktop-entry'

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

check('splitExec 拆分空白与双引号', () => {
  assert.deepEqual(splitExec('/usr/bin/app --foo "bar baz"'), [
    '/usr/bin/app',
    '--foo',
    'bar baz'
  ])
  assert.deepEqual(splitExec('  a   b  '), ['a', 'b'])
  assert.deepEqual(splitExec('/path/with\\ space/app'), ['/path/with space/app'])
  assert.deepEqual(splitExec('"quoted arg" plain'), ['quoted arg', 'plain'])
})

check('stripFieldCodes 剥离字段码与 %%', () => {
  assert.deepEqual(stripFieldCodes(['/usr/bin/app', '%U']), ['/usr/bin/app'])
  assert.deepEqual(stripFieldCodes(['%f', '%F', '%u', '%U']), [])
  assert.deepEqual(stripFieldCodes(['--file=%f']), ['--file='])
  assert.deepEqual(stripFieldCodes(['100%%']), ['100%'])
  assert.deepEqual(stripFieldCodes(['%i']), [])
})

check('execTargetIndex 跳过 env 与 KEY=VALUE', () => {
  assert.equal(execTargetIndex(['/usr/bin/app', '--x']), 0)
  assert.equal(execTargetIndex(['env', 'GTK_THEME=dark', '/usr/bin/app', '--x']), 2)
  assert.equal(execTargetIndex(['/usr/bin/env', 'A=1', 'B=2', '/usr/bin/app']), 3)
  assert.equal(execTargetIndex(['env']), -1)
})

check('parseDesktopEntry 只读 [Desktop Entry] 并解析字段', () => {
  const entry = parseDesktopEntry(
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Firefox',
      'Name[zh_CN]=火狐浏览器',
      'GenericName=Web Browser',
      'Exec=/usr/bin/firefox %u',
      'TryExec=firefox',
      'Path=/home/me',
      'Terminal=false',
      'NoDisplay=false',
      'Icon=firefox',
      '',
      '[Desktop Action new-window]',
      'Name=New Window',
      'Exec=/usr/bin/firefox --new-window'
    ].join('\n')
  )
  assert.ok(entry)
  assert.equal(entry.type, 'Application')
  assert.equal(entry.name, 'Firefox')
  assert.equal(entry.nameMap['zh_CN'], '火狐浏览器')
  assert.equal(entry.exec, '/usr/bin/firefox %u')
  assert.equal(entry.tryExec, 'firefox')
  assert.equal(entry.path, '/home/me')
  assert.equal(entry.terminal, false)
})

check('parseDesktopEntry 缺少 Type 或段落时返回 null', () => {
  assert.equal(parseDesktopEntry('Name=x'), null)
  assert.equal(parseDesktopEntry('[Other]\nType=Application\nName=x'), null)
})

check('locale 候选与本地化 Name', () => {
  assert.deepEqual(localeCandidates('zh_CN.UTF-8'), [
    'zh_CN.UTF-8',
    'zh_CN',
    'zh-CN',
    'zh'
  ])
  const map = { zh_CN: '火狐', 'zh-CN': '火狐浏览器', ja: 'ファイアフォックス' }
  assert.equal(pickLocalized(map, 'Firefox', 'zh-CN'), '火狐浏览器')
  assert.equal(pickLocalized(map, 'Firefox', 'zh_CN.UTF-8'), '火狐')
  assert.equal(pickLocalized(map, 'Firefox', 'ja_JP'), 'ファイアフォックス')
  assert.equal(pickLocalized(map, 'Firefox', 'en_US'), 'Firefox')
})

check('resolveExecTarget 绝对路径原样返回', () => {
  assert.equal(resolveExecTarget('/usr/bin/app', '/bin', () => false), '/usr/bin/app')
})

check('resolveExecTarget 裸命令按 PATH 查找', () => {
  const seen: string[] = []
  const target = resolveExecTarget('firefox', '/opt/bin:/usr/bin', (candidate) => {
    seen.push(candidate)
    return candidate === '/usr/bin/firefox'
  })
  assert.equal(target, '/usr/bin/firefox')
  assert.deepEqual(seen, ['/opt/bin/firefox', '/usr/bin/firefox'])
  assert.equal(resolveExecTarget('missing', '/usr/bin', () => false), '')
})

console.log('desktop-entry.test: all passed')
