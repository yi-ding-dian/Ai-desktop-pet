/**
 * launcher/application-scan 离线自测（node 直接运行，不需要 Electron）：
 *   npm run test:launcher
 *
 * 覆盖：XDG 根顺序、.desktop 过滤、本地化名、Exec 路径/PATH 解析、wrapper/
 * 终端/失效标记，以及按名匹配的优先级与多候选。
 */
import assert from 'node:assert/strict'
import {
  applicationRoots,
  findApplications,
  parseApplicationFiles,
  type ApplicationFile,
  type ScannedApp
} from './application-scan'

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

const isExecutable = (candidate: string): boolean =>
  [
    '/usr/bin/firefox',
    '/usr/bin/gedit',
    '/usr/bin/flatpak',
    '/usr/bin/broken'
  ].includes(candidate) && candidate !== '/usr/bin/broken'

function desktop(id: string, body: string[]): ApplicationFile {
  return {
    id,
    filePath: `/usr/share/applications/${id}.desktop`,
    content: ['[Desktop Entry]', ...body].join('\n')
  }
}

check('XDG 根顺序：DATA_HOME → DATA_DIRS → flatpak/snap', () => {
  const roots = applicationRoots(
    { XDG_DATA_HOME: '/data', XDG_DATA_DIRS: '/a:/b' },
    '/home/me'
  )
  assert.deepEqual(roots.slice(0, 3), [
    '/data/applications',
    '/a/applications',
    '/b/applications'
  ])
  assert.ok(roots.includes('/home/me/.local/share/flatpak/exports/share/applications'))
  assert.ok(roots.includes('/var/lib/snapd/desktop/applications'))
})

check('parseApplicationFiles 解析字段、本地化名与 PATH', () => {
  const files = [
    desktop('firefox', [
      'Type=Application',
      'Name=Firefox',
      'Name[zh_CN]=火狐浏览器',
      'Exec=/usr/bin/firefox %u',
      'Icon=firefox'
    ]),
    desktop('gedit', [
      'Type=Application',
      'Name=Text Editor',
      'GenericName=Text Editor',
      'Exec=gedit %U',
      'TryExec=gedit'
    ]),
    desktop('org.gnome.gedit-flatpak', [
      'Type=Application',
      'Name=Gedit Flatpak',
      'Exec=/usr/bin/flatpak run org.gnome.gedit %U'
    ]),
    desktop('terminal-app', [
      'Type=Application',
      'Name=Terminal App',
      'Exec=/usr/bin/gedit',
      'Terminal=true'
    ]),
    desktop('hidden-app', [
      'Type=Application',
      'Name=Hidden',
      'Exec=/usr/bin/gedit',
      'NoDisplay=true'
    ]),
    desktop('link-app', ['Type=Link', 'Name=Link', 'URL=https://a.com']),
    desktop('broken-app', [
      'Type=Application',
      'Name=Broken',
      'Exec=/usr/bin/broken',
      'TryExec=/usr/bin/missing'
    ])
  ]

  const apps = parseApplicationFiles(files, {
    locale: 'zh-CN',
    pathEnv: '/usr/bin',
    isExecutable
  })
  const byId = Object.fromEntries(apps.map((item) => [item.id, item]))

  assert.equal(byId['hidden-app'], undefined)
  assert.equal(byId['link-app'], undefined)

  assert.equal(byId['firefox'].name, '火狐浏览器')
  assert.equal(byId['firefox'].execPath, '/usr/bin/firefox')
  assert.equal(byId['firefox'].hasArgs, false)
  assert.equal(byId['firefox'].available, true)

  assert.equal(byId['gedit'].execPath, '/usr/bin/gedit')
  assert.equal(byId['gedit'].genericName, 'Text Editor')

  assert.equal(byId['org.gnome.gedit-flatpak'].wrapper, true)
  assert.equal(byId['org.gnome.gedit-flatpak'].hasArgs, true)

  assert.equal(byId['terminal-app'].needsTerminal, true)
  assert.equal(byId['broken-app'].available, false)
})

function app(partial: Partial<ScannedApp> & { id: string; name: string }): ScannedApp {
  return {
    genericName: '',
    execPath: '/usr/bin/app',
    execArgv: ['/usr/bin/app'],
    hasArgs: false,
    needsTerminal: false,
    available: true,
    wrapper: false,
    desktopFile: `/usr/share/applications/${partial.id}.desktop`,
    icon: '',
    workingDir: '',
    ...partial
  }
}

check('findApplications 精确名 / id / GenericName / 唯一子串', () => {
  const apps = [
    app({ id: 'firefox', name: 'Firefox', genericName: 'Web Browser' }),
    app({ id: 'org.gnome.gedit', name: 'Text Editor', genericName: 'Editor' }),
    app({ id: 'code', name: 'Visual Studio Code' }),
    app({ id: 'vlc', name: 'VLC media player' })
  ]

  assert.equal(findApplications(apps, 'Firefox').match?.id, 'firefox')
  assert.equal(findApplications(apps, 'firefox').match?.id, 'firefox')
  assert.equal(findApplications(apps, 'org.gnome.gedit').match?.id, 'org.gnome.gedit')
  assert.equal(findApplications(apps, 'Web Browser').match?.id, 'firefox')
  assert.equal(findApplications(apps, 'gedit').match?.id, 'org.gnome.gedit')
  assert.equal(findApplications(apps, 'Visual Studio').match?.id, 'code')
  assert.equal(findApplications(apps, 'VLC').match?.id, 'vlc')
})

check('findApplications 多候选去重、最多 5 个', () => {
  const apps = Array.from({ length: 8 }, (_, index) =>
    app({ id: `editor-${index}`, name: `Editor ${index}` })
  )
  const result = findApplications(apps, 'Editor')
  assert.equal(result.match, undefined)
  assert.ok(result.candidates.length <= 5)
  assert.equal(new Set(result.candidates.map((item) => item.name)).size, result.candidates.length)
})

check('findApplications 失效应用单独提示、无匹配返回空', () => {
  const unavailable = app({
    id: 'gone',
    name: 'Gone App',
    available: false,
    execPath: ''
  })
  const result = findApplications([unavailable], 'Gone App')
  assert.equal(result.unavailable?.id, 'gone')

  const none = findApplications([app({ id: 'x', name: 'X' })], '不存在')
  assert.equal(none.match, undefined)
  assert.equal(none.candidates.length, 0)
  assert.equal(none.unavailable, undefined)
})

console.log('scan.test: all passed')
