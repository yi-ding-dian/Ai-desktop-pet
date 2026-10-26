/**
 * 行为执行器（设计文档 §4.5.5 / §7.4）：**后端决策、前端执行**的"身体"。
 *
 * 后端下发的是指令级消息（如"向右走 300px"），不是位置流——前端本地完成
 * 窗口缓动（主进程 moveTo 逐帧 setBounds）与动画配合，结束或被打断后回报
 * behavior_done；移动期间 WS 上没有任何实时数据。
 *
 * 打断来源（任一即立即停止移动与动画、回报 {interrupted:true}）：
 * - 用户抓取/摸头（App 的 hitbox pointerdown → interruptPetBehavior）；
 * - 新对话开始（WS state → thinking/speaking）；
 * - 引擎唤醒（用户回来时对 nap/sleep 推 state:idle，设计文档 §4.5.2）；
 * - 收到新行为指令（防御性抢占；正常链路引擎串行下发不会出现）。
 *
 * 行为参数约定（与后端 behaviors.py 对齐）：所有行为带 duration_ms；
 * walk 另带 direction（"left"/"right"）与 distance（px）。
 */
import { getPetBridge } from '../../../shared/pet-bridge'
import type { BehaviorData, StateData } from '../../../shared/protocol'
import type { WsClient } from '../../../shared/ws-client'
import { playPetReaction, setPetState } from '../controller'
// 教学模式本地镜像（P5 §7.5；放在零依赖的 state.ts，避免 pet ↔ teaching 循环依赖）
import { isTeachingMode } from '../../teaching/state'
// 工作模式本地镜像（2026-10-18；同样零依赖，避免 pet ↔ work 循环依赖）
import { isWorkModeActive } from '../../work-mode/state'
// 贴边吸附保持（2026-10-20）：吸附后不执行自主行为，避免被 walk 带走
import { isPetEdgeSnapLocked } from '../edge-state'

/** 行为执行状态（供状态栏展示：名称 + 参数摘要） */
export interface BehaviorStatus {
  id: string
  name: string
  detail: string
}

/** dev 态日志（转发到主进程日志，便于无 devtools 验证）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[pet/behavior] ${msg}`)
}

/** 从 params 取数值并夹取（params 来自后端，宽容处理） */
function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(n, min), max)
}

/** 可中断等待（abort 时立即 resolve；调用方查 signal.aborted 判断结果） */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 参数摘要（日志/状态栏展示） */
function describe(data: BehaviorData): string {
  if (data.name === 'walk') {
    const direction = data.params.direction === 'left' ? '左' : '右'
    const distance = data.params.distance
    return `向${direction}${typeof distance === 'number' ? ` ${Math.round(distance)}px` : ''}`
  }
  const durationMs = data.params.duration_ms
  return typeof durationMs === 'number' ? `${Math.round(durationMs / 1000)}s` : ''
}

/** look_around 反应循环周期（与渲染器 animator 的 LOOK_AROUND 时长对齐） */
const LOOK_AROUND_CYCLE_MS = 2800

export class BehaviorExecutor {
  private readonly client: WsClient
  /** 进行中的行为（null = 空闲） */
  private active: { id: string; name: string; controller: AbortController } | null = null
  private readonly statusHandlers = new Set<(status: BehaviorStatus | null) => void>()

  constructor(client: WsClient) {
    this.client = client
  }

  /** 订阅 WS 事件（behavior 指令 + state 打断判断）；返回清理函数 */
  start(): () => void {
    const offBehavior = this.client.on('behavior', (data) => this.handle(data))
    const offState = this.client.on('state', (data) => this.onWsState(data))
    return () => {
      offBehavior()
      offState()
    }
  }

  /** 订阅执行状态变化（App 状态栏）；返回取消订阅函数 */
  onStatus(cb: (status: BehaviorStatus | null) => void): () => void {
    this.statusHandlers.add(cb)
    return () => {
      this.statusHandlers.delete(cb)
    }
  }

  /** 收到 behavior 指令（新指令抢占进行中的旧行为——防御性） */
  handle(data: BehaviorData): void {
    // 教学模式/工作模式防御（P5 §7.5.4、2026-10-18）：后端尚未接 set_mode——若仍收到
    // 自主行为指令，不动窗口不播动作、不进入执行流程，立即按"被打断"回报（引擎照常记账/
    // 冷却，讲课/工作时宠物要待在依附位不打扰）。本地标记由主进程广播镜像维护
    // （teaching/state.ts、work/state.ts）；两种模式外恒为 false，走既有路径。
    const quietMode = isTeachingMode()
      ? '教学模式'
      : isWorkModeActive()
        ? '工作模式'
        : isPetEdgeSnapLocked()
          ? '贴边吸附'
          : null
    if (quietMode !== null) {
      const sent = this.client.send('behavior_done', { id: data.id, interrupted: true })
      devLog(
        `${quietMode}中收到行为 ${data.name}（${data.id}）：跳过执行，behavior_done{interrupted} 上报=${sent}`
      )
      return
    }
    if (this.active) {
      this.interrupt('收到新行为指令（抢占）')
    }
    void this.run(data)
  }

  /** 中断当前行为（用户交互/对话/唤醒触发；无进行中的行为时忽略） */
  interrupt(reason: string): void {
    const active = this.active
    if (!active || active.controller.signal.aborted) return
    devLog(`行为 ${active.name}（${active.id}）被打断：${reason}`)
    active.controller.abort()
    // 移动中的窗口立即停下（未在移动时是无害空操作）
    getPetBridge().window.cancelMove()
  }

  // ---------------------------------------------------------------- 内部

  private onWsState(data: StateData): void {
    const active = this.active
    if (!active) return
    if (data.state === 'thinking' || data.state === 'speaking' || data.state === 'dragging') {
      this.interrupt(`新对话/拖拽（state=${data.state}）`)
    } else if (data.state === 'idle' && (active.name === 'nap' || active.name === 'sleep')) {
      // 引擎"用户回来"唤醒：对睡眠行为推 state:idle（设计文档 §4.5.2：回来时唤醒）
      this.interrupt('被唤醒（state=idle）')
    }
  }

  private async run(data: BehaviorData): Promise<void> {
    const controller = new AbortController()
    this.active = { id: data.id, name: data.name, controller }
    const signal = controller.signal
    devLog(`收到行为 ${data.name} id=${data.id} params=${JSON.stringify(data.params)}`)
    this.emitStatus({ id: data.id, name: data.name, detail: describe(data) })

    try {
      switch (data.name) {
        case 'walk':
          await this.executeWalk(data, signal)
          break
        case 'nap':
        case 'sleep':
          await this.executeRest(data, signal)
          break
        case 'look_around':
          await this.executeLookAround(data, signal)
          break
        default:
          await this.executeUnknown(data, signal)
      }
    } catch (err) {
      console.error('[pet/behavior] 行为执行异常：', err)
    } finally {
      const isCurrent = this.active?.id === data.id
      if (isCurrent) {
        if (signal.aborted) {
          // 保险：中断路径已取消过移动，这里兜底（重复调用无害）
          getPetBridge().window.cancelMove()
        }
        setPetState('idle')
        this.active = null
      }
      const interrupted = signal.aborted
      const sent = this.client.send('behavior_done', { id: data.id, interrupted })
      if (isCurrent) this.emitStatus(null)
      devLog(
        `行为 ${data.name}（${data.id}）结束：interrupted=${interrupted}，behavior_done 上报=${sent}`
      )
    }
  }

  /** walk：窗口缓动移动 + walking 状态（颠步动画） */
  private async executeWalk(data: BehaviorData, signal: AbortSignal): Promise<void> {
    const bridge = getPetBridge()
    const distance = pickNumber(data.params.distance, 240, 40, 800)
    const direction = data.params.direction === 'left' ? -1 : 1
    const durationMs = pickNumber(
      data.params.duration_ms,
      Math.round((distance / 140) * 1000),
      200,
      8000
    )

    // 实时取窗口几何（不用缓存：用户可能刚拖拽过）；目标被主进程 clamp 到工作区
    const geo = await bridge.window.getGeometry()
    if (signal.aborted) return
    const targetX = geo.pos.x + direction * distance

    setPetState('walking')
    const result = await bridge.window.moveTo(targetX, geo.pos.y, durationMs)
    devLog(
      `walk 移动结束：目标 x=${targetX} 实际 x=${result.x} completed=${result.completed}` +
        `（被取消则按打断回报）`
    )
  }

  /** nap / sleep：进入 sleeping 状态并保持 duration_ms（被唤醒/对话打断时提前结束） */
  private async executeRest(data: BehaviorData, signal: AbortSignal): Promise<void> {
    const durationMs = pickNumber(data.params.duration_ms, 30_000, 1000, 200_000)
    setPetState('sleeping')
    await sleep(durationMs, signal)
  }

  /** look_around：原地张望（渲染器反应循环播放，不改变窗口/状态） */
  private async executeLookAround(data: BehaviorData, signal: AbortSignal): Promise<void> {
    const durationMs = pickNumber(data.params.duration_ms, 3000, 500, 15_000)
    let elapsed = 0
    while (elapsed < durationMs && !signal.aborted) {
      playPetReaction('look_around')
      const step = Math.min(LOOK_AROUND_CYCLE_MS, durationMs - elapsed)
      await sleep(step, signal)
      elapsed += step
    }
  }

  /** 未知行为（后端先行扩展）：不猜语义、不做动作，按 duration_ms 静默等待 */
  private async executeUnknown(data: BehaviorData, signal: AbortSignal): Promise<void> {
    devLog(`未知行为 ${data.name}：仅按 duration_ms 等待（前端暂无该动作实现）`)
    const durationMs = pickNumber(data.params.duration_ms, 0, 0, 200_000)
    if (durationMs > 0) {
      await sleep(durationMs, signal)
    }
  }

  private emitStatus(status: BehaviorStatus | null): void {
    for (const cb of this.statusHandlers) {
      try {
        cb(status)
      } catch (err) {
        console.error('[pet/behavior] 状态订阅者抛错：', err)
      }
    }
  }
}
