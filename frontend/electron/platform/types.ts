/**
 * 平台层类型契约（照 svn-git 的 `src/platform/types.ts` 路子，但只收本项目的实际需要）。
 *
 * 边界：这里只放**跨域共用**的平台事实与平台常量。某个域独有的平台行为
 * （tray 的 DDE 原生菜单、settings 的 X 层僵尸窗探针…）留在那个域里，只从本层取平台判定——
 * 不为了"集中"把域的知识搬过来（搬过来反而把域的知识摊到了公共层）。
 */

/**
 * 仅 Linux 需要设置的 Electron 窗口选项。
 *
 * 用途（宠物窗实测结论）：DDE(Dock) 会忽略 `skipTaskbar`，`type: 'toolbar'` 能让 Dock
 * 不出窗口格；该字段 Electron 只在 Linux 认，故其余平台返回空对象（展开后等于没加）。
 */
export interface LinuxOnlyWindowOptions {
  type?: 'toolbar'
}

/**
 * 默认工作区解析所需的系统目录（由主进程注入，平台层不 import electron）。
 *
 * Windows / Linux 都优先「用户文档目录」，拿不到再退「家目录」——两边规则一致，
 * 但集中在本层，新增平台时只改 `DEFAULT_WORKSPACE_BASE` 一行。
 */
export interface DefaultWorkspaceHost {
  documents: string
  home: string
}

/**
 * 后端启动路径：开发态 venv 解释器（相对 `backend/` 的路径段）+ 生产态 onedir 产物名。
 *
 * 为什么必须按平台取：PyInstaller **不支持交叉编译**，后端产物只能在本平台构建，
 * 所以 `backend.exe` / `backend`、`Scripts/python.exe` / `bin/python` 这些名字没有统一写法。
 */
export interface BackendLaunchNames {
  /** 开发态 venv 解释器：Windows = ['Scripts','python.exe']，类 Unix = ['bin','python'] */
  readonly venvPython: readonly string[]
  /** 生产态 PyInstaller onedir 可执行名：Windows = 'backend.exe'，类 Unix = 'backend' */
  readonly exeName: string
}

/**
 * `applyWindowsAppIdentity` 的最小宿主依赖。
 *
 * 用结构化类型而不是直接 import Electron 的 `App`：本层**不得 import electron**（见 index.ts
 * 文件头——preload 也要用它，而 preload 里没有 `app`）。顺带白拿一个好处：单测可传桩。
 */
export interface AppIdentityHost {
  setAppUserModelId(id: string): void
}
