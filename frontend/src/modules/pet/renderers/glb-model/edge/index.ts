/**
 * 屏幕边缘动作编排（2026-10-20）。
 *
 * 输入：主进程实时推送的窗口贴边状态（'top' | 'left' | 'right' | 'none'，顶部优先）。
 * 输出：对应模型接管画面（progress 进入），离开边缘退回站姿。
 *
 * 优先级约定：
 * - **睡姿优先**：sleeping 时 `setEnabled(false)`，边缘模型立即让位（不等待退出过渡），
 *   醒来后若仍在边缘再自动进入；
 * - **跨边直接切换**：左→右/顶时不保留旧模型的退出过渡，旧模型瞬时隐藏、画布立刻改挂新边，
 *   避免旧模型跟着画布跑到新边缘的错位画面；
 * - 离开边缘（→ none）保留退出过渡，画布等模型淡出完再回中，避免"模型瞬移回中间"。
 */
import type * as THREE from 'three'
import type { PetWindowEdge } from '../../../../../../electron/ipc/channels'
import { SLEEP_WIDTH_RATIO_LIGHT } from '../sleep/config'
import { SleepZzzOverlay } from '../sleep/zzz'
import {
  EDGE_BOTTOM_MODEL_URL,
  EDGE_HANG_MODEL_URL,
  EDGE_LEFT_MODEL_URL,
  EDGE_RIGHT_MODEL_URL
} from './config'
import { EdgeModel, type EdgeKind, type EdgeModelHost, type EdgeView } from './model'

/** 遍历顺序：悬挂优先于左右；底部优先级最低（与主进程判定一致） */
const KINDS: EdgeKind[] = ['top', 'left', 'right', 'bottom']

/** dev 态日志（转发到主进程日志）；生产构建自动剔除 */
const devLog = (msg: string): void => {
  if (import.meta.env.DEV) console.log(`[pet] ${msg}`)
}

export class EdgeController {
  private readonly models: Record<EdgeKind, EdgeModel>
  private readonly zzz = new SleepZzzOverlay()
  private host: EdgeModelHost | null = null
  private target: EdgeKind | null = null
  private enabled = true
  /** 用户拖拽中：只保留目标边缘做光带提示，不切换模型/不移动画布（松手吸附后才应用） */
  private dragging = false
  /** 是否已真正贴住工作区边（底部预挂阶段为 false：只跟随，不出光带/不吸附） */
  private nearSnap = false
  /** 实际接管的边缘（含退出过渡期间）；用于渲染画布挂到窗口哪条边 */
  private current: EdgeKind | null = null
  private lastDesired: EdgeKind | null = null
  private attached = false

  constructor() {
    this.models = {
      left: new EdgeModel('left', EDGE_LEFT_MODEL_URL),
      right: new EdgeModel('right', EDGE_RIGHT_MODEL_URL),
      top: new EdgeModel('top', EDGE_HANG_MODEL_URL),
      bottom: new EdgeModel('bottom', EDGE_BOTTOM_MODEL_URL)
    }
  }

  attach(host: EdgeModelHost & { overlayHost: HTMLElement }): void {
    this.host = host
    this.attached = true
    for (const kind of KINDS) this.models[kind].attach(host)
    // 底部趴睡的 Zzz 覆盖层（与真实睡眠共用同一个组件类，位置锚点也一致）
    this.zzz.attach(host.overlayHost)
  }

  detach(): void {
    for (const kind of KINDS) this.models[kind].detach()
    this.zzz.detach()
    this.attached = false
  }

  setView(view: EdgeView): void {
    for (const kind of KINDS) this.models[kind].setView(view)
  }

  /** 站姿模型就绪后调用：三个边缘模型并行懒加载；底部睡姿按站姿宽度归一化 */
  preload(standWidth: number): void {
    this.models.bottom.setTargetWidth(standWidth * SLEEP_WIDTH_RATIO_LIGHT)
    for (const kind of KINDS) this.models[kind].preload()
  }

  /** 主进程贴边状态 → 目标边缘（near = 已真正贴边；底部预挂阶段为 false） */
  setEdge(edge: PetWindowEdge, near = true): void {
    devLog(`edge set -> ${edge}${near ? '（贴边）' : '（预挂）'}（enabled=${this.enabled}）`)
    this.target = edge === 'none' ? null : edge
    this.nearSnap = near
  }

  /**
   * 拖拽状态（2026-10-20）：拖拽中**只显示光带、不切模型/不移画布**。
   * 原因：判定按宠物模型边缘（半个身位），此时窗口会伸出屏幕很多；
   * 若立即把画布挂到窗口边，宠物会跳到屏幕外。松手吸附到位后再应用。
   */
  setDragging(value: boolean): void {
    this.dragging = value
  }

  /** 拖拽中的目标边缘（供光带提示；'none' = 不在触发范围） */
  get targetEdge(): PetWindowEdge {
    return this.target ?? 'none'
  }

  /** 是否已真正贴住工作区边（底部预挂阶段 false，不显示光带/不提示吸附） */
  get nearSnapActive(): boolean {
    return this.nearSnap
  }

  /** 睡姿优先：睡着时禁用边缘动作（醒来后重新进入仍有效的目标） */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return
    this.enabled = on
    if (!on) {
      // 立即让位：睡姿进入与边缘退出同时做会重影
      for (const kind of KINDS) this.models[kind].hideNow()
      this.current = null
      this.lastDesired = null
    }
  }

  update(dt: number): void {
    // 非拖拽时只有"真正贴边/脚碰底"（near）才显示模型；底部预挂残留（near=false）保持站姿
    const desired = this.enabled && !this.dragging && this.nearSnap ? this.target : null
    // 跨边（left↔right↔top）：旧模型瞬时收起，避免画布已改挂而旧模型仍停在旧边
    if (desired !== this.lastDesired && this.lastDesired !== null && desired !== null) {
      this.models[this.lastDesired].hideNow()
    }
    if (desired !== this.lastDesired) {
      devLog(
        `edge update desired=${desired} ready=${desired ? this.models[desired].ready : '-'} ` +
          `visible=${desired ? this.models[desired].visibleNow : '-'}`
      )
    }
    this.lastDesired = desired

    for (const kind of KINDS) {
      this.models[kind].setVisible(kind === desired)
      this.models[kind].update(dt)
    }

    if (desired && this.models[desired].visibleNow) {
      this.current = desired
    } else if (this.current && this.models[this.current].visibleNow) {
      // 退出过渡中：画布保持在原边缘，等淡出结束再回中
    } else {
      this.current = desired && this.models[desired].ready ? desired : null
    }

    // 底部趴睡时显示 Zzz（跟随进入/退出过渡；与真实睡眠的 Zzz 互斥，同一时刻只有一个可用）
    this.zzz.setVisible(this.models.bottom.visibleNow)
  }

  /** 是否接管画面（站姿/表情层隐藏的条件之一） */
  get coversStand(): boolean {
    return KINDS.some((kind) => this.models[kind].visibleNow)
  }

  /**
   * 渲染画布应挂到窗口哪条边（'none' = 居中）。
   * 预挂（near=false）只在**拖拽中**挂边；静止时未真正贴边就回中——
   * 否则点击摸头/停在预挂区时，画布会把宠物"吸"到窗口底部。
   */
  get hostEdge(): PetWindowEdge {
    if (this.nearSnap || this.dragging) return this.target ?? this.current ?? 'none'
    return this.current ?? 'none'
  }

  /** raycaster 必须已 setFromCamera；null = 未接管 */
  hitTest(raycaster: THREE.Raycaster): boolean | null {
    for (const kind of KINDS) {
      const hit = this.models[kind].hitTest(raycaster)
      if (hit !== null) return hit
    }
    return null
  }

  dispose(): void {
    for (const kind of KINDS) this.models[kind].dispose()
    this.zzz.dispose()
    this.attached = false
  }
}
