/**
 * 编码代理任务编排（2026-10-23）。
 *
 * 职责：
 * - 工作区授权（用户选目录 / 绝对路径校验 / 保护目录拒绝）；
 * - 启动确认气泡（工作区 + 任务摘要）；
 * - 拉起 dsh ACP 会话，把 `session/update` 转成步骤流并广播；
 * - 把 `session/request_permission` 转成确认气泡（允许 = allow_once）；
 * - 任务结束/取消/超时后回收进程树，写审计日志。
 *
 * 安全边界：本模块不执行任何 shell、不读写用户文件；所有执行都发生在 dsh
 * 子进程自己的沙箱与权限策略里，宠物这边只是“代用户点同意/拒绝”。
 */
import { app, BrowserWindow, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CodingCancelResult,
  CodingStartRequest,
  CodingStartResult,
  CodingState
} from '../ipc/channels'
import { IPC_EVENTS } from '../ipc/channels'
import { openConfirmBubble } from '../bubble'
import { openWork } from '../work'
import type { ExtraProtectedRoot } from '../system/path-safety'
import { AcpSession, describePermission, type AcpPermissionRequest } from './acp'
import { resolveHarnessCommand, resolveNpxCommand } from './command'
import { isDeepSeekBaseUrl, requestLlmKey, type LlmKeyPayload } from './keybridge'
import {
  codingHarnessHome,
  resolveAppRuntime
} from './runtime'
import { backendManager } from '../backend-process'
import { codingPreferencesFile, loadCodingPreferences } from './preferences'
import { CodingStepStore } from './steps'
import { validateWorkspace } from './workspace'

/** 任务总时长上限：到点强制中止，避免无人看守 */
const TASK_TIMEOUT_MS = 30 * 60 * 1000
/** 状态推送节流（毫秒）：长任务每个 token 都推送会压垮 IPC */
const PUSH_THROTTLE_MS = 250
/** 任务描述展示/传递给子进程的上限 */
const MAX_TASK_LENGTH = 2000
/** 进度步骤保留上限（与 steps.ts 默认一致） */
const MAX_STEPS = 300

function emptyState(): CodingState {
  return {
    taskId: null,
    status: 'idle',
    task: '',
    workspace: '',
    steps: []
  }
}

/** 去掉可能出现在错误信息里的密钥样式文本 */
export function sanitizeErrorText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(api[_-]?key["']?\s*[:=]\s*)\S+/gi, '$1***')
}

/** 把常见启动错误翻成可操作的中文提示（原始信息保留在末尾） */
export function friendlyHarnessError(text: string): string {
  if (/Authentication Fails|api key.*(invalid|无效)|invalid.*api key/i.test(text)) {
    return (
      '编码代理的 API Key 无效。请先在 dsh 里配置有效的 DeepSeek Key' +
      '（或设置 DEEPSEEK_API_KEY 环境变量）后再试。\n' +
      `原始信息：${text}`
    )
  }
  if (/profile .*acp.* does not exist/i.test(text)) {
    return (
      '本机的 dsh 版本过旧，没有 acp 服务。请执行 ' +
      '`npm install -g @deepseek-ai/dsh@0.2.1-rc.2` 升级后再试。\n' +
      `原始信息：${text}`
    )
  }
  if (/ENOENT|not recognized|不是内部或外部命令/i.test(text)) {
    return (
      '没找到编码代理。请到「设置 → LLM → 编码代理」点「安装」，' +
      '或先安装 Node.js（自带 npm）。\n' +
      `原始信息：${text}`
    )
  }
  return text
}

/** 从当前后端进程取宠物 LLM Key（未就绪/未配置返回 null；不写日志） */
async function fetchPetLlmKey(): Promise<LlmKeyPayload | null> {
  const snapshot = backendManager.getSnapshot()
  const token = backendManager.getInternalToken()
  if (!snapshot.port || !token) return null
  return requestLlmKey({
    baseUrl: `http://127.0.0.1:${snapshot.port}`,
    token
  })
}

/** 保护目录：小兔自己的程序/数据/日志目录，编码代理不允许在这里干活 */
function protectedRoots(): ExtraProtectedRoot[] {
  const roots: ExtraProtectedRoot[] = []
  const add = (raw: string | undefined): void => {
    if (raw) roots.push({ path: raw, descendants: true, reason: '这是小兔自己的目录' })
  }
  add(app.getAppPath())
  add(app.getPath('userData'))
  try {
    add(app.getPath('logs'))
  } catch {
    // 某些平台没有 logs 路径
  }
  return roots
}


class CodingService {
  private state: CodingState = emptyState()
  private store = new CodingStepStore({ maxSteps: MAX_STEPS })
  private session: AcpSession | null = null
  private busy = false
  private cancelRequested = false
  private timedOut = false
  private pushTimer: NodeJS.Timeout | null = null
  private taskTimer: NodeJS.Timeout | null = null
  /** 取消后若编码代理不配合，10 秒后强制回收进程 */
  private forceStopTimer: NodeJS.Timeout | null = null

  /** 是否有任务在跑（安装/卸载前检查，避免动正在使用的 runtime） */
  isBusy(): boolean {
    return this.busy || this.session !== null
  }

  getState(): CodingState {
    return {
      ...this.state,
      steps: this.state.steps.map((step) => ({ ...step }))
    }
  }

  async start(request: CodingStartRequest, parent: BrowserWindow | null): Promise<CodingStartResult> {
    if (this.busy || this.state.status === 'running' || this.state.status === 'waiting' || this.state.status === 'starting') {
      return { ok: false, message: '已经有一个编码任务在跑，先中止它再开新的。' }
    }
    // 先占位：目录选择/确认气泡可能停留很久，期间不允许第二个任务进来
    this.busy = true
    const fail = (message: string): CodingStartResult => {
      this.busy = false
      return { ok: false, message }
    }

    const task = typeof request?.task === 'string' ? request.task.trim() : ''
    if (!task) return fail('要做什么？给我一句具体的任务描述。')
    if (task.length > MAX_TASK_LENGTH) {
      return fail(`任务描述太长了（最多 ${MAX_TASK_LENGTH} 字），先说重点。`)
    }

    let workspace: { ok: true; path: string } | { ok: false; message: string }
    try {
      workspace = await this.resolveWorkspace(request?.workspace, parent)
    } catch (error) {
      return fail(
        `没能打开目录选择框：${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!workspace.ok) return fail(workspace.message)

    let confirmed = false
    try {
      confirmed = await openConfirmBubble({
        message:
          `要让编码代理在这个文件夹里干活吗？\n${workspace.path}\n\n` +
          `任务：${task.length > 400 ? `${task.slice(0, 400)}…` : task}\n` +
          '它会自己改文件、跑命令；每一步风险操作都会再来问你。',
        confirmLabel: '开始',
        cancelLabel: '取消'
      })
    } catch {
      return fail('确认气泡没弹出来，再试一次好吗？')
    }
    if (!confirmed) return fail('好，那先不做啦。')

    this.cancelRequested = false
    this.timedOut = false
    this.store.reset()
    this.state = {
      taskId: randomUUID(),
      status: 'starting',
      task,
      workspace: workspace.path,
      steps: [],
      startedAt: Date.now()
    }
    this.store.addSystem('任务已开始', workspace.path)
    this.syncSteps()
    this.push(true)

    // 复用宠物 LLM Key：现取现用，Key 只进子进程环境变量，不落盘不进日志。
    // 用隔离的 DSH_HOME——dsh 的存储凭据优先于环境变量，用户自己 ~/.dsh 里
    // 可能有失效的旧 Key。
    const preferences = loadCodingPreferences(
      codingPreferencesFile(app.getPath('userData'))
    )
    let childEnv: NodeJS.ProcessEnv = {}
    let keySource: 'pet' | 'dsh' = 'dsh'
    if (preferences.reuseLlmKey) {
      const payload = await fetchPetLlmKey()
      if (payload && isDeepSeekBaseUrl(payload.baseUrl)) {
        const home = codingHarnessHome()
        try {
          fs.mkdirSync(home, { recursive: true })
        } catch {
          // 建不了目录就回退 dsh 自己的配置
        }
        childEnv = { DEEPSEEK_API_KEY: payload.key, DSH_HOME: home }
        keySource = 'pet'
      } else if (payload) {
        // LLM 换成了非 DeepSeek 服务商：这把 Key 不能给编码代理用
        this.store.addSystem('小兔的 LLM 不是 DeepSeek，编码代理改用 dsh 自己的凭据')
        this.syncSteps()
      }
    }
    this.audit({ event: 'start', task, workspace: workspace.path, keySource })

    let session: AcpSession | null = null
    try {
      const command = resolveHarnessCommand({ appRuntime: resolveAppRuntime() })
      const launch = (exe: string, baseArgs: string[]): Promise<AcpSession> =>
        AcpSession.start({
          executable: exe,
          baseArgs,
          cwd: workspace.path,
          env: childEnv,
          onUpdate: (update) => this.onUpdate(update),
          onPermission: (permission) => this.onPermission(permission),
          onStderr: (line) => {
            if (process.env.PET_DSH_DEBUG) console.warn(`[coding] ${line}`)
          },
          onExit: (info) => {
            if (!this.cancelRequested) {
              this.audit({
                event: 'process-exit',
                code: info.code,
                signal: info.signal
              })
            }
          }
        })
      try {
        session = await launch(command.executable, command.baseArgs)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        // 版本探测失败时可能选中了旧版 dsh（没有 acp profile）：自动用 npx 再试一次
        const staleProfile = /profile .*acp.* does not exist/i.test(text)
        const fallback = staleProfile && command.source !== 'npx' ? resolveNpxCommand() : null
        if (!fallback) throw error
        this.audit({ event: 'retry-npx', reason: 'acp profile missing' })
        session = await launch(fallback.executable, fallback.baseArgs)
      }
    } catch (error) {
      const message = friendlyHarnessError(
        sanitizeErrorText(error instanceof Error ? error.message : String(error))
      )
      this.busy = false
      this.finish('error', message)
      return { ok: false, message: `编码代理没启动起来：${message}` }
    }
    if (!session) {
      this.busy = false
      this.finish('error', '编码代理没有建立会话')
      return { ok: false, message: '编码代理没启动起来，再试一次好吗？' }
    }

    // 启动期间用户点了「中止」：不用跑任务，直接回收
    if (this.cancelRequested) {
      this.busy = false
      this.finish('cancelled')
      await session.dispose()
      return { ok: false, message: '好，已经停下来了。' }
    }

    this.session = session
    this.state.status = 'running'
    this.push(true)
    try {
      openWork()
    } catch {
      // 工作窗打不开不影响任务本身
    }

    this.taskTimer = setTimeout(() => {
      if (this.session) {
        this.timedOut = true
        this.cancelRequested = true
        this.store.addSystem('任务超时，正在中止')
        this.audit({ event: 'timeout' })
        this.session.cancel()
        this.scheduleForceStop(this.session)
      }
    }, TASK_TIMEOUT_MS)

    void this.runPrompt(session, task)
    return { ok: true, taskId: this.state.taskId ?? undefined }
  }

  async cancel(): Promise<CodingCancelResult> {
    // 启动阶段（还在握手/建会话）也允许取消：先记下意图，启动完成后立即回收
    if (!this.busy && !this.session) {
      return { ok: false, message: '现在没有在跑的编码任务。' }
    }
    if (this.cancelRequested) return { ok: true, message: '已经在停了，等我一下。' }
    this.cancelRequested = true
    this.store.addSystem('收到中止请求')
    this.audit({ event: 'cancel' })
    this.syncSteps()
    this.session?.cancel()
    if (this.session) this.scheduleForceStop(this.session)
    this.touch()
    return { ok: true, message: '好，我让它停下了。' }
  }

  /** 取消/超时后的兜底：编码代理不响应 cancel 就直接结束会话（等 10 秒） */
  private scheduleForceStop(session: AcpSession): void {
    if (this.forceStopTimer) return
    this.forceStopTimer = setTimeout(() => {
      this.forceStopTimer = null
      void session.dispose()
    }, 10_000)
  }

  // ---------------------------------------------------------------- 内部流程

  private async resolveWorkspace(
    raw: string | undefined,
    parent: BrowserWindow | null
  ): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
    const provided = typeof raw === 'string' ? raw.trim() : ''
    const rules = { extraProtectedRoots: protectedRoots() }
    if (provided) return validateWorkspace(provided, rules)

    const options: Electron.OpenDialogOptions = {
      title: '选择要让编码代理工作的项目目录',
      buttonLabel: '用这个文件夹',
      properties: ['openDirectory']
    }
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, message: '还没选文件夹，那先不做啦。' }
    }
    return validateWorkspace(picked.filePaths[0], rules)
  }

  private onUpdate(update: { sessionUpdate: string; [key: string]: unknown }): void {
    // 权限等待期间的 update 也照常显示（dsh 可能在等确认前先吐进度）
    this.store.apply(update)
    this.syncSteps()
    this.touch()
  }

  private async onPermission(permission: AcpPermissionRequest): Promise<'allow' | 'reject'> {
    this.state.status = 'waiting'
    this.store.addSystem(
      `等待你确认：${permission.title || permission.kind || '一个操作'}`,
      permission.detail
    )
    this.syncSteps()
    this.push(true)

    const detail = describePermission(permission)
    let confirmed = false
    try {
      confirmed = await openConfirmBubble({
        message:
          `编码代理要执行一个操作，允许吗？\n${detail.length > 400 ? `${detail.slice(0, 400)}…` : detail}`,
        confirmLabel: '允许',
        cancelLabel: '拒绝'
      })
    } catch {
      // 气泡弹不出来 = 无法取得授权 → 按拒绝处理
      confirmed = false
    }

    if (!this.cancelRequested) {
      this.state.status = 'running'
    }
    this.audit({
      event: 'permission',
      title: permission.title,
      kind: permission.kind,
      detail: permission.detail,
      decision: confirmed ? 'allow' : 'reject'
    })
    this.touch()
    return confirmed ? 'allow' : 'reject'
  }

  private async runPrompt(session: AcpSession, task: string): Promise<void> {
    try {
      const { stopReason } = await session.prompt(task)
      if (this.timedOut) {
        this.finish('error', `任务超过 ${TASK_TIMEOUT_MS / 60_000} 分钟，已自动中止。`)
      } else if (this.cancelRequested) {
        this.finish('cancelled')
      } else if (stopReason === 'end_turn') {
        this.finish('done')
      } else if (stopReason === 'cancelled') {
        this.finish('cancelled')
      } else if (stopReason === 'refusal') {
        this.finish('error', '编码代理拒绝了这次任务。')
      } else if (stopReason === 'max_tokens') {
        this.finish('error', '编码代理达到输出上限，任务没有完成。')
      } else {
        this.finish('error', `编码代理提前结束（${stopReason}）。`)
      }
    } catch (error) {
      if (this.timedOut) {
        this.finish('error', `任务超过 ${TASK_TIMEOUT_MS / 60_000} 分钟，已自动中止。`)
      } else if (this.cancelRequested) {
        this.finish('cancelled')
      } else {
        const tail = session.stderrTail.slice(-5).join('\n')
        const message = friendlyHarnessError(
          sanitizeErrorText(error instanceof Error ? error.message : String(error))
        )
        this.finish('error', tail ? `${message}\n${tail}` : message)
      }
    } finally {
      if (this.taskTimer) {
        clearTimeout(this.taskTimer)
        this.taskTimer = null
      }
      if (this.forceStopTimer) {
        clearTimeout(this.forceStopTimer)
        this.forceStopTimer = null
      }
      this.session = null
      this.busy = false
      await session.dispose()
      this.push(true)
    }
  }

  private finish(status: CodingState['status'], error?: string): void {
    if (this.state.status === 'done' || this.state.status === 'cancelled' || this.state.status === 'error') {
      return
    }
    this.store.sealStreams()
    this.syncSteps()
    const summary = this.store.summary()
    this.state.status = status
    this.state.endedAt = Date.now()
    if (status === 'done') {
      this.state.summary = summary || '编码代理完成了一轮任务。'
      this.store.addSystem('任务完成')
    } else if (status === 'cancelled') {
      this.store.addSystem('任务已中止')
    } else {
      this.state.error = error ?? '编码代理执行失败。'
      this.store.addSystem('任务失败', this.state.error)
    }
    this.syncSteps()
    this.audit({ event: 'end', status, error: error ?? null })
    this.push(true)
  }

  private syncSteps(): void {
    this.state.steps = this.store.list()
  }

  /** 节流推送状态快照 */
  private touch(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.push(true)
    }, PUSH_THROTTLE_MS)
  }

  private push(immediate = false): void {
    if (!immediate && this.pushTimer) return
    const snapshot = this.getState()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send(IPC_EVENTS.CODING_STATE, snapshot)
      } catch {
        // 窗口正在销毁
      }
    }
  }

  private audit(entry: Record<string, unknown>): void {
    try {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
      fs.appendFile(path.join(dir, 'coding-audit.jsonl'), `${line}\n`, () => {
        // 审计失败不影响任务
      })
    } catch {
      // 同上
    }
  }
}

/** 进程级单例（IPC 处理器与窗口共用） */
export const codingService = new CodingService()
