/**
 * 后端可执行文件定位（设计文档 §1.2 / §5.2）。
 *
 * 开发态：直接跑源码 —— `<项目根>/backend/.venv/bin/python -m backend.main`（cwd 必须是项目根）；
 * 生产态：PyInstaller onedir 产物 `resources/backend/backend`（预留，本期未打包验证）。
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BACKEND_LAUNCH_NAMES } from '../platform'

/** 后端启动参数（spawn 用） */
export interface BackendLaunchSpec {
  /** 可执行文件绝对路径 */
  command: string
  args: string[]
  /** 工作目录（开发态必须是项目根，`-m backend.main` 依赖它） */
  cwd: string
  /** 日志用描述 */
  label: string
}

/** 开发态项目根：electron-vite dev 下 app.getAppPath() 为 frontend/ */
function devProjectRoot(): string {
  return resolve(app.getAppPath(), '..')
}

export function locateBackend(): BackendLaunchSpec {
  if (!app.isPackaged) {
    const projectRoot = devProjectRoot()
    // 解释器路径段按平台取（Windows: Scripts/python.exe，类 Unix: bin/python）——见 electron/platform
    const venvPython = join(projectRoot, 'backend', '.venv', ...BACKEND_LAUNCH_NAMES.venvPython)
    if (!existsSync(venvPython)) {
      throw new Error(`开发态 Python 解释器不存在：${venvPython}（先创建 backend/.venv）`)
    }
    return {
      command: venvPython,
      args: ['-m', 'backend.main'],
      cwd: projectRoot,
      label: `${venvPython} -m backend.main（cwd=${projectRoot}）`
    }
  }

  // 生产态：PyInstaller onedir 产物放在 resources/backend/（设计文档 §8.1，本期待打包后验证）
  const exeName = BACKEND_LAUNCH_NAMES.exeName
  const dir = join(process.resourcesPath, 'backend')
  return {
    command: join(dir, exeName),
    args: [],
    cwd: dir,
    label: `${join(dir, exeName)}（生产态）`
  }
}
