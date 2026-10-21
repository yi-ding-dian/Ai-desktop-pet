/**
 * 根组件：宠物（部件动画渲染器）+ 对话面板 + 开发向状态显示（顶部：宠物状态/情绪；底部：调试栏）。
 *
 * 开发向信息（顶部状态栏 / 底部调试栏）默认隐藏、不渲染（面向最终用户不应可见）；
 * Ctrl+Shift+D 切换显隐：渲染侧本地监听（窗口有焦点时）+ 主进程 globalShortcut 转发（穿透/失焦时）。
 *
 * P1 打通后：WS 连接与后端状态经 shared/ws-client 与 pet-bridge 接入；
 * 宠物本体由 pet 域（§5.3 可插拔渲染器）提供——当前为程序化 SVG 部件动画，
 * 将来接入 Live2D 渲染器时只替换渲染器实现，本文件不需要改动。
 *
 * P5 教学模式（§7.5）：App 侧接线——onState 订阅（面板收起/气泡显隐/讲台走位）、
 * 头顶问题气泡（TeachingBubbles）集成与形状上报、拖拽联动折叠（notifyDragStart）。
 * 对话镜像/统一发送等无 UI 部分在 modules/teaching 域内实现。
 *
 * P4 设置向导（§7.6.6）：settings.onVisibility 订阅（向导期间聊天面板收起 + 右眼右上萌语
 * 气泡）在 modules/settings-guide 域内实现，App 只做 UI 接线与形状上报；飞位动画由主进程 ball-animation 编排。
 *
 * 工具机制（§4.7）：后端 tool_call 事件 → 前端按 name 执行（如 open_settings 打开设置窗），
 * 执行器在 modules/tools 域内实现，App 只做接线。
 *
 * 说话气泡（§5.4，2026-10-16）：聊天回复/错误以气泡展示在兔子头部旁（chat 域 speech.ts 驱动，
 * 气泡窗归 electron/bubble 域）——App 只做接线 + 抑制协调（教学/向导中不弹，进入抑制态时收起）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { getPetBridge } from './shared/pet-bridge'
import { setupWsFromBridge } from './shared/ws-client/bridge'
import type { WsClient, WsConnectionState } from './shared/ws-client'
import { subscribeBubbleIdleSeconds } from './shared/bubble-settings'
import { getPetScale } from './shared/pet-scale'
// chat 域入口（输入行组件 + 说话气泡驱动 + 会话记录 + 情绪映射）
import {
  ChatPanel,
  setupSpeechBubble,
  dismissSpeechBubble,
  speakLifecycleLine,
  setupNameOnboarding,
  setupChatHistory,
  emotionEmoji,
  showChatNotice
} from './modules/chat'
import {
  PetView,
  setupPetBehaviors,
  interruptPetBehavior,
  subscribeBehaviorStatus,
  setPetConversationActive,
  setPetState,
  isPixelHitTestActive,
  type BehaviorStatus
} from './modules/pet'
import { lockPetEdgeSnap } from './modules/pet/edge-state'
import {
  setupTeachingPetSide,
  subscribeTeachingState,
  subscribeTeachingBubbles,
  gotoTeachingBubble,
  notifyTeachingDragStart,
  TeachingBubbles,
  type TeachingBubbleItem
} from './modules/teaching'
import { setupToolExecutor } from './modules/tools'
import { setupWorkPetSide } from './modules/work'
import { isWorkModeActive, subscribeWorkActive } from './modules/work/state'
import { setupReminders } from './modules/reminders'
import {
  setupSettingsGuidePetSide,
  subscribeSettingsGuide,
  SettingsGuideBubble
} from './modules/settings-guide'
import {
  setupVoice,
  subscribeVoiceSpeaking,
  playDebugTone,
  installVoiceDebugHook
} from './modules/voice'
import type { BackendState, TeachingStatePayload, WindowDebugState } from '../electron/ipc/channels'
import type { PetState } from './shared/protocol'
import type { Point, Rect } from '../electron/window'

const INITIAL_DEBUG_STATE: WindowDebugState = {
  clickThrough: true,
  alwaysOnTop: true,
  hitboxVisible: false
}

/**
 * 教学模式折叠判定阈值（px）：pointerdown 后位移超过它才算"真拖拽"→ 通知主进程折叠黑板。
 * 与 PetView 的点击判定（TAP_MOVE_THRESHOLD=6）同值——"轻点=摸头，拖动=让路"语义互斥。
 */
const TEACHING_DRAG_NOTIFY_PX = 6

/**
 * 进入拖拽的位移阈值（px，2026-10-20）：pointerdown 只记录起点，位移超过该值才标记
 * `data-dragging` 并开始移动窗口。否则纯点击（摸头）也会被渲染器当成拖拽，
 * 窗口位于屏幕下半部时立刻触发底部预挂，宠物"一点就滑到底部"。
 */
const DRAG_START_THRESHOLD_PX = 6

/** 宠物状态机 → 中文展示（protocol.py StateData 全量取值） */
const STATE_LABEL: Record<PetState, string> = {
  idle: '待机',
  walking: '走动',
  sleeping: '睡觉',
  thinking: '思考中',
  speaking: '说话',
  dragging: '拖拽中'
}

/** WS 连接状态 → 中文展示 */
const WS_LABEL: Record<WsConnectionState, string> = {
  idle: '未连接',
  connecting: '连接中',
  authenticating: '鉴权中',
  connected: '已连接',
  reconnecting: '重连中',
  'auth-failed': '鉴权失败',
  closed: '已断开'
}

/** 后端状态 → 中文展示 */
const BACKEND_LABEL: Record<BackendState | 'unknown', string> = {
  unknown: '未知',
  starting: '启动中',
  ready: '就绪',
  failed: '失败',
  stopped: '已停止'
}

export default function App(): ReactElement {
  const [debug, setDebug] = useState<WindowDebugState>(INITIAL_DEBUG_STATE)
  const [wsState, setWsState] = useState<WsConnectionState>('idle')
  const [petState, setPetState] = useState<PetState>('idle')
  const [emotion, setEmotion] = useState<string>('neutral')
  const [backendState, setBackendState] = useState<BackendState | 'unknown'>('unknown')
  const [lastError, setLastError] = useState<string | null>(null)
  /** 本地语音是否在播（voice 域 §4.4；状态栏"🔊 说话中"提示） */
  const [voiceSpeaking, setVoiceSpeaking] = useState(false)
  /** 自主行为执行状态（P3 §4.5.5；null = 未在执行） */
  const [behaviorStatus, setBehaviorStatus] = useState<BehaviorStatus | null>(null)
  /**
   * 开发向信息显隐（顶部状态栏 + 底部调试栏共用）：默认隐藏、不渲染；
   * Ctrl+Shift+D 切换（渲染侧 keydown + 主进程全局快捷键事件两条路径，均翻转本状态）
   */
  const [debugBarVisible, setDebugBarVisible] = useState(false)
  /** 教学模式状态（P5 §7.5；主进程为权威，teaching 域 onState 订阅镜像到此处驱动 UI） */
  const [teachingState, setTeachingState] = useState<TeachingStatePayload>({ mode: 'normal', folded: false })
  /** 头顶问题气泡列表（教学模式中用户提问；课堂目录，点击回看） */
  const [teachingBubbles, setTeachingBubbles] = useState<TeachingBubbleItem[]>([])
  /** 设置向导进行中（§7.6.6：设置窗打开 → 聊天面板收起 + 右眼右上方萌语气泡显隐） */
  const [guideActive, setGuideActive] = useState(false)
  /** 工作模式进行中（2026-10-18：工作窗可见 → 宠物输入框收起 + 回复气泡不显示） */
  const [workActive, setWorkActive] = useState(isWorkModeActive)
  /** 窗口贴边（2026-10-20：悬挂/探头动作接管时收起输入条，画面只留宠物） */
  const [edgeAttached, setEdgeAttached] = useState(false)
  /** 贴上/下边吸附中（2026-10-21）：主进程会抑制说话气泡，提醒到达时据此补系统通知 */
  const topBottomEdgeRef = useRef(false)
  const hitboxRef = useRef<HTMLDivElement | null>(null)
  const statusBarRef = useRef<HTMLDivElement | null>(null)
  const chatPanelRef = useRef<HTMLDivElement | null>(null)
  /** 头顶气泡容器（教学模式可见时纳入交互矩形上报；X11 形状裁剪会裁掉未上报区域） */
  const teachingBubblesRef = useRef<HTMLDivElement | null>(null)
  /** 向导萌语气泡容器（同上：可见时必须纳入形状上报） */
  const settingsGuideRef = useRef<HTMLDivElement | null>(null)
  /**
   * 教学讲台走位任务（进入/恢复教学模式时宠物走回讲台位）：
   * seq = 任务序号（新任务/拖拽取消使旧任务失效）；active = 是否正在走位（拖拽需取消窗口缓动）
   */
  const teachingWalkRef = useRef<{ seq: number; active: boolean }>({ seq: 0, active: false })
  const hoveringRef = useRef(false)
  const draggingRef = useRef(false)

  // WS 连接（幂等单例；订阅 backend ready 后自动建连）
  const wsClient: WsClient = useMemo(() => setupWsFromBridge(), [])

  // ---- voice 域接线（P2 §4.4）：audio 二进制帧 → 播放队列 + 口型驱动；打断随 reply_end ----
  useEffect(() => setupVoice(wsClient), [wsClient])

  // 本地"说话中"状态（状态栏提示）
  useEffect(() => subscribeVoiceSpeaking(setVoiceSpeaking), [])

  // ---- 情绪回落挂起信号（pet 域 controller）：对话/说话进行中情绪不回落，说完才倒计时 ----
  // 信号 = WS thinking（它在想/在回复）+ 本地语音播放中（后端推 idle 只是帧发完、嗓子还在响）
  useEffect(() => {
    setPetConversationActive(petState === 'thinking' || petState === 'speaking' || voiceSpeaking)
  }, [petState, voiceSpeaking])

  // ---- 自主行为接线（P3 §4.5.5/§7.4）：behavior 指令执行 + 环境上报（env_update） ----
  useEffect(() => setupPetBehaviors(wsClient), [wsClient])

  // 行为执行状态（状态栏展示"它正在做什么"；须在 setup 的 effect 之后声明）
  useEffect(() => subscribeBehaviorStatus(setBehaviorStatus), [])

  // ---- 教学模式接线（P5 §7.5）：onState 分发 / 黑板输入转发 / 对话镜像均在 teaching 域内实现 ----
  // 注：新增 bridge API 需重启 Electron 主进程才可用；旧 preload 无 teaching 段时静默跳过
  useEffect(() => setupTeachingPetSide(wsClient), [wsClient])

  // ---- 工作模式接线（2026-10-18）：工作窗发送/历史/打断 ↔ 宠物窗 WS 与对话镜像 ----
  useEffect(() => setupWorkPetSide(wsClient), [wsClient])

  // ---- 工具执行器接线（§4.7 工具机制）：后端 tool_call 事件 → 前端按 name 执行（如 open_settings 开设置窗） ----
  useEffect(() => setupToolExecutor(wsClient), [wsClient])

  // ---- 说话气泡接线（chat 域 §5.4）：回复/错误以气泡展示在兔子头部旁 ----
  // 抑制判定经 ref 现读（setup 只跑一次，闭包捕获的状态会过期）：教学（内容在黑板）/向导（有萌语气泡）
  // 中不弹；进入抑制态时立即收起正在显示的说话气泡（让位）
  const speechSuppressedRef = useRef(false)
  // 工作模式只抑制"对话回复气泡"（输入框已在工作窗里）；提醒/称呼引导仍走原判定，不被工作窗静音
  const workActiveRef = useRef(false)
  useEffect(() => subscribeWorkActive(setWorkActive), [])
  useEffect(() => {
    workActiveRef.current = workActive
    if (workActive) dismissSpeechBubble()
  }, [workActive])
  useEffect(() => {
    speechSuppressedRef.current = teachingState.mode === 'teaching' || guideActive
    if (speechSuppressedRef.current) dismissSpeechBubble()
  }, [teachingState.mode, guideActive])
  useEffect(
    () =>
      setupSpeechBubble(wsClient, {
        shouldSuppress: () => speechSuppressedRef.current || workActiveRef.current
      }),
    [wsClient]
  )

  // ---- 生命周期台词（2026-10-18）：启动落地"我来了~" / 退出捕获前"再见啦~" ----
  // 主进程 ball-animation 域负责时序；这里只把台词交给说话气泡（退出时强制展示，流式回复让位）。
  useEffect(() => {
    try {
      const off = getPetBridge().lifecycle?.onSay?.(({ text, ttlMs, kind }) => {
        speakLifecycleLine(text, { ttlMs, force: kind === 'farewell' })
      })
      return () => off?.()
    } catch {
      // 旧 preload / 浏览器直开调试：无 lifecycle 桥，静默跳过（不影响启动与退出）
      return
    }
  }, [])

  // ---- 启动称呼引导（2026-10-18）：画像里没有用户名字时，问候收尾后问一句 ----
  // 提问/拒绝冷却都在 chat 域的 name-onboarding 里；这里只传抑制判定（教学/向导中不问）。
  useEffect(
    () => setupNameOnboarding(wsClient, { shouldSuppress: () => speechSuppressedRef.current }),
    [wsClient]
  )

  // ---- 提醒接线（reminders 域，2026-10-18）：后端 proactive{kind:'reminder'} → 气泡 + 系统通知 ----
  // 气泡一定会出（与语音开关无关）；教学/向导/隐藏/流式中排队，恢复后补气泡
  useEffect(
    () =>
      setupReminders(wsClient, {
        shouldSuppress: () => speechSuppressedRef.current,
        // 贴上/下边吸附中气泡被静默：提醒补系统通知（见 reminders 域 ReminderOptions）
        isEdgeSpeechSuppressed: () => topBottomEdgeRef.current
      }),
    [wsClient]
  )

  // ---- 会话记录接线（chat 域）：本次会话问答记录——说话气泡「展开」进教学时预填黑板的数据源 ----
  useEffect(() => setupChatHistory(wsClient), [wsClient])

  /**
   * 讲台走位（进入教学模式 / 折叠恢复时）：宠物走回讲台位（复用 moveTo 缓动）。
   * - 距离 ≤30px 不动（已在讲台位）；
   * - 走位前中断进行中的自主行为（防窗口缓动抢控制权）；
   * - 中断后稍候再置 walking：行为执行器中断路径的收尾（经 IPC 往返回渲染侧）会
   *   setPetState('idle')，立即置 walking 会被迟到事件覆盖掉；
   * - 拖拽打断 / 退出教学 / 新走位发生时旧任务作废（seq 守卫），被取消的旧任务不再回写状态。
   */
  const walkToTeachingPodium = useCallback(async (podium: Point): Promise<void> => {
    const walk = teachingWalkRef.current
    const mySeq = ++walk.seq
    walk.active = true // 任务进行中（含前置阶段）——拖拽/退出可经 cancelTeachingWalk 作废
    let moved = false
    try {
      const geo = await getPetBridge().window.getGeometry()
      if (walk.seq !== mySeq) return
      if (Math.hypot(geo.pos.x - podium.x, geo.pos.y - podium.y) <= 30) return
      interruptPetBehavior('进入教学模式')
      await new Promise((resolve) => window.setTimeout(resolve, 60))
      if (walk.seq !== mySeq) return
      moved = true
      setPetState('walking')
      await getPetBridge().window.moveTo(podium.x, podium.y, 1200)
    } catch (err) {
      console.error('[teaching] 讲台走位失败：', err)
    } finally {
      if (walk.seq === mySeq) {
        walk.active = false
        if (moved) setPetState('idle')
      }
    }
  }, [])

  /** 取消进行中的讲台走位（用户拖拽打断 / 退出教学模式）：作废任务 + 停窗口缓动 + 回 idle */
  const cancelTeachingWalk = useCallback((reason: string): void => {
    const walk = teachingWalkRef.current
    if (!walk.active) return
    walk.active = false
    walk.seq += 1
    getPetBridge().window.cancelMove()
    setPetState('idle')
    console.log(`[teaching] 讲台走位取消（${reason}）`)
  }, [])

  // ---- 教学状态/气泡订阅：面板收起、气泡显隐、讲台走位（onState 经 teaching 域分发到此处） ----
  useEffect(() => {
    const offState = subscribeTeachingState((state) => {
      setTeachingState(state)
      if (state.mode !== 'teaching') {
        // 退出教学模式：在跑的讲台走位一并取消（气泡已由 teaching 域清空）
        cancelTeachingWalk('退出教学模式')
        return
      }
      // 讲台入位改由**主进程 relocate（forceGlide 滑步）**实现（见 teaching 域 glidePetToPodium，
      // 2026-10-16）：原渲染侧 walkTo 会因 moveTo 的工作区夹取让兔子停在半路（讲台位窗底允许越界）。
      // podium 字段保留（兼容旧版本渲染侧）。
    })
    const offBubbles = subscribeTeachingBubbles(setTeachingBubbles)
    return () => {
      offState()
      offBubbles()
    }
  }, [walkToTeachingPodium, cancelTeachingWalk])

  // ---- 设置向导接线（§7.6.6）：onVisibility 订阅在 settings-guide 域内实现 ----
  // 注：新增 bridge API 需重启 Electron 主进程才可用；旧 preload 无 settings 段时静默跳过
  useEffect(() => {
    const offSetup = setupSettingsGuidePetSide()
    const offSub = subscribeSettingsGuide(setGuideActive)
    return () => {
      offSub()
      offSetup()
    }
  }, [])

  // ---- 气泡系统：清空聊天占位（宠物窗口右键菜单 → 清空确认气泡【清空】→ 主进程发出本事件） ----
  // 本任务只留 console 日志占位；清空的后端/前端逻辑归后续任务。
  // 注：旧 preload 无 chat 段时静默跳过（可选链容错）
  useEffect(() => {
    const off = getPetBridge().chat?.onClearRequested?.(() => {
      console.log('[pet] 收到「清空聊天」请求（占位：清空逻辑归后续任务）')
    })
    return () => off?.()
  }, [])

  // ---- dev 调试：V 键播放合成测试音（验证"帧→播放→口型→清理"全链路；输入框内不拦截） ----
  useEffect(() => {
    if (!import.meta.env.DEV) return
    installVoiceDebugHook()
    const onKeyDown = (e: KeyboardEvent): void => {
      // 排除带修饰键的组合（Ctrl+V 等粘贴快捷键的 e.key 也是 'v'，曾误触发测试音）
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.toLowerCase() !== 'v') return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
      playDebugTone()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ---- 调试栏显隐：Ctrl+Shift+D（渲染侧监听；窗口有焦点时生效，穿透/失焦场景由主进程全局快捷键兜底） ----
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) return
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return
      if (e.key.toLowerCase() !== 'd') return
      e.preventDefault()
      setDebugBarVisible((v) => !v)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ---- 调试栏显隐：主进程全局快捷键（Ctrl+Shift+D）转发事件（主进程只转发，不持有状态，避免双方状态漂移） ----
  // 注意：新增的 bridge API 需重启 Electron 主进程才可用（dev 下主进程不热更）；
  // 旧 preload 无该方法时静默跳过（渲染侧 keydown 路径仍可用，见上）
  useEffect(() => {
    const off = getPetBridge().window.onToggleDebugBar?.(() => setDebugBarVisible((v) => !v))
    return () => off?.()
  }, [])

  // ---- 主进程/后端状态订阅 ----
  useEffect(() => {
    const bridge = getPetBridge()
    void bridge.window.getDebugState().then(setDebug)
    const offDebug = bridge.window.onDebugStateChanged(setDebug)

    void bridge.backend.getSnapshot().then((snap) => setBackendState(snap.state))
    const offBackend = bridge.backend.onStatusChanged((s) => setBackendState(s.state))
    return () => {
      offDebug()
      offBackend()
    }
  }, [])

  // ---- WS 事件订阅：宠物状态 / 情绪 / 错误（顶栏与底栏展示） ----
  useEffect(() => {
    const offs = [
      wsClient.onStateChange(setWsState),
      wsClient.on('state', (d) => setPetState(d.state)),
      wsClient.on('emotion', (d) => setEmotion(d.emotion)),
      // 文件分析等一次性提示：聊天面板上方轻提示（不进历史、不弹气泡）
      wsClient.on('notice', (d) =>
        showChatNotice(
          d.message,
          d.level === 'warn' ? 'warn' : d.level === 'error' ? 'error' : 'info',
          // 记忆本清单可能较长：多留阅读时间（其余提示维持 8s）
          d.code === 'items_listed' ? 20_000 : 8_000
        )
      ),
      wsClient.on('error', (d) => setLastError(`${d.code}: ${d.message}`))
    ]
    return () => offs.forEach((off) => off())
  }, [wsClient])

  // ---- 回复气泡自动收起时长：后端 config 为准，保存后由设置窗广播即时同步 ----
  const applyBubbleIdle = useCallback((seconds: number): void => {
    try {
      getPetBridge().bubble?.setIdleTimeout?.(seconds)
    } catch {
      /* 旧 preload / bridge 缺失：主进程保持默认 30s */
    }
  }, [])

  useEffect(() => subscribeBubbleIdleSeconds(applyBubbleIdle), [applyBubbleIdle])

  useEffect(() => {
    const offConfig = wsClient.on('config', (config) => {
      const petCfg = (config as { pet?: { bubble_idle_seconds?: unknown } }).pet
      const raw = petCfg?.bubble_idle_seconds
      const seconds = typeof raw === 'number' ? raw : Number(raw)
      if (Number.isFinite(seconds)) applyBubbleIdle(seconds)
    })
    const offState = wsClient.onStateChange((state) => {
      if (state === 'connected') wsClient.send('get_config', {})
    })
    if (wsClient.connectionState === 'connected') wsClient.send('get_config', {})
    return () => {
      offConfig()
      offState()
    }
  }, [applyBubbleIdle, wsClient])

  // ---- 首启引导检测（P4 §7.6.5）：LLM 未配置（base_url 空）→ 自动打开设置窗 ----
  // （引导模式由设置页自行判定——它读到空 base_url 即展示服务商预设欢迎条，无需参数）
  // 仅本次会话首次连接时检测一次：用户本轮暂不配置就不再打扰，下次启动再弹
  useEffect(() => {
    let checked = false
    const offState = wsClient.onStateChange((s) => {
      if (s === 'connected' && !checked) {
        checked = true
        wsClient.send('get_config', {})
      }
    })
    const offConfig = wsClient.on('config', (d) => {
      const llm = (d as { llm?: { base_url?: unknown } }).llm
      const baseUrl = typeof llm?.base_url === 'string' ? llm.base_url : ''
      if (baseUrl.trim() === '') {
        console.log('[pet] 首启引导：LLM 未配置（base_url 空），自动打开设置窗口')
        getPetBridge().settings?.open?.()
      }
    })
    return () => {
      offState()
      offConfig()
    }
  }, [wsClient])

  /** 教学模式展开态（气泡显示 + 聊天面板收起；折叠让路态：气泡也藏——面板已随教学模式整体收起） */
  const teachingExpanded = teachingState.mode === 'teaching' && !teachingState.folded

  // ---- 悬停接管（旧逻辑，矩形 hitbox）：mousemove 检测光标是否在宠物 hitbox 内 ----
  // Linux：物理穿透由窗口形状静态保证，本逻辑负责"形状接管 ↔ 全窗接管"的动态切换；
  // Windows：本逻辑是穿透切换的主力（forward 可转发穿透态下的 mousemove）。
  // 空气让路整合（§5.1 增补，2026-10-16）：当前渲染器实现像素级命中（hitTest）时，
  // 输入判定与上报全权交主进程接管状态机（pet 域 pixel-hit-test：实体/空气 + 让路态光标轮询），
  // 本逻辑短路停用——避免"hitbox 进出"与"像素命中"双源打架；渲染器未实现时保持本逻辑（fallback）。
  useEffect(() => {
    const bridge = getPetBridge()

    const handleMove = (e: MouseEvent): void => {
      if (draggingRef.current) return // 拖拽期间穿透由拖拽流程控制，避免跟随抖动误开穿透
      if (isPixelHitTestActive()) return // 渲染器支持像素级命中：交主进程状态机（见上注释）
      const el = hitboxRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const inside =
        e.clientX >= rect.left && e.clientX < rect.right && e.clientY >= rect.top && e.clientY < rect.bottom
      if (inside === hoveringRef.current) return
      hoveringRef.current = inside
      console.log(`[pet] hitbox ${inside ? 'enter' : 'leave'}`)
      bridge.window.setClickThrough(!inside)
    }

    window.addEventListener('mousemove', handleMove)
    return () => window.removeEventListener('mousemove', handleMove)
  }, [])

  // ---- 拖拽（自绘：pointerdown 起点 + pointermove 坐标流 → 主进程 setBounds 跟随；禁用 -webkit-app-region） ----
  // 不用主进程轮询 screen.getCursorScreenPoint()：该 API 在 X11 上为事件驱动缓存（实测光标出窗即冻结），
  // 渲染侧 pointer capture 能保证光标滑出窗口后事件仍连续送达（X11 指针 grab），坐标更可靠。
  useEffect(() => {
    const el = hitboxRef.current
    if (!el) return
    const bridge = getPetBridge()
    let rafId = 0
    let pending: { x: number; y: number } | null = null
    /** 教学模式折叠判定：本次拖拽的起点（screen 坐标）与"已通知折叠"标志（每次按下重置） */
    let teachingDragOrigin: { x: number; y: number } | null = null
    let teachingDragNotified = false
    /** 是否已越过位移阈值、真正进入拖拽（点击/微动不算） */
    let dragMarked = false

    const flush = (): void => {
      rafId = 0
      if (pending) {
        bridge.window.dragMove(pending)
        pending = null
      }
    }

    const handlePointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 || draggingRef.current) return
      // 用户开始摸头/拖拽 → 立即中止自主行为（设计文档 §4.5.2 不打扰原则：
      // 行为永不抢占用户交互；中止后执行器会上报 behavior_done{interrupted:true}）
      interruptPetBehavior('用户触摸/抓取')
      // 教学模式中"拖动=让路"的折叠通知**不在此处**（按下即通知会把轻点摸头误判为拖拽）：
      // 改为 pointermove 位移超过 TEACHING_DRAG_NOTIFY_PX 才通知一次（见 handlePointerMove）
      teachingDragOrigin = { x: e.screenX, y: e.screenY }
      teachingDragNotified = false
      dragMarked = false
      draggingRef.current = true
      el.setPointerCapture(e.pointerId)
      console.log('[pet] drag start')
      bridge.window.startDrag({ x: e.screenX, y: e.screenY })
      e.preventDefault()
    }

    const handlePointerMove = (e: PointerEvent): void => {
      if (!draggingRef.current) return
      // 位移未超过阈值：只是点击/手抖，不进入拖拽（不标记 data-dragging、不移动窗口）
      if (!dragMarked) {
        const sx = teachingDragOrigin?.x ?? e.screenX
        const sy = teachingDragOrigin?.y ?? e.screenY
        if (Math.hypot(e.screenX - sx, e.screenY - sy) < DRAG_START_THRESHOLD_PX) return
        dragMarked = true
        // 吸附特效/预挂只在真正拖拽中生效
        el.dataset.dragging = 'true'
      }
      // 教学模式中"拖动=让路"：位移超过阈值才通知一次折叠（轻点摸头不会触发）
      if (
        !teachingDragNotified &&
        teachingDragOrigin &&
        Math.hypot(e.screenX - teachingDragOrigin.x, e.screenY - teachingDragOrigin.y) >
          TEACHING_DRAG_NOTIFY_PX
      ) {
        teachingDragNotified = true
        notifyTeachingDragStart()
      }
      // 教学讲台走位进行中被拖拽打断：作废走位任务并取消窗口缓动（拖拽与缓动互斥，
      // 同刻两个 setBounds 源会抢窗口控制权）
      cancelTeachingWalk('用户拖拽')
      // rAF 节流：pointermove 频率可能远高于帧率，每帧最多发一次坐标
      pending = { x: e.screenX, y: e.screenY }
      if (!rafId) rafId = requestAnimationFrame(flush)
    }

    const handlePointerUp = (e: PointerEvent): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      dragMarked = false
      delete el.dataset.dragging
      teachingDragOrigin = null
      // 最后对齐到抬起位置，再结束拖拽
      bridge.window.dragMove({ x: e.screenX, y: e.screenY })
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      pending = null
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      console.log('[pet] drag end')
      bridge.window.endDrag()
      // 贴边松手 → 吸附保持：自主行为全部跳过，避免吸附后又被 walk 带走
      lockPetEdgeSnap()
      // 拖拽结束时不改穿透：光标仍在宠物上 → 保持接管；移出时 mousemove 逻辑会恢复
    }

    el.addEventListener('pointerdown', handlePointerDown)
    el.addEventListener('pointermove', handlePointerMove)
    el.addEventListener('pointerup', handlePointerUp)
    el.addEventListener('pointercancel', handlePointerUp)
    return () => {
      el.removeEventListener('pointerdown', handlePointerDown)
      el.removeEventListener('pointermove', handlePointerMove)
      el.removeEventListener('pointerup', handlePointerUp)
      el.removeEventListener('pointercancel', handlePointerUp)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  // ---- 可交互区域上报（Linux 用作 X11 形状穿透的输入区） ----
  // 组成：宠物视觉包围盒（见下；必须 ≥ 渲染范围，防止被形状裁剪）+ hitbox + 聊天面板 + 状态栏（显示时）
  //      + 头顶问题气泡容器（教学模式展开态）/ 向导萌语气泡（设置向导中）——X11 形状裁剪会裁掉未上报区域
  // 聊天面板/气泡尺寸会随消息变化，用 ResizeObserver 跟随，rAF 合并上报频次。
  // 依赖 debugBarVisible/teachingExpanded/guideActive：容器挂载/卸载时，需重建观察并重报矩形（隐藏时不含对应容器）。
  useEffect(() => {
    const bridge = getPetBridge()
    let rafId = 0

    const doReport = (): void => {
      // 贴边动作接管时收起输入条：画面只留悬挂/探头的宠物（dataset 由渲染器写入 hitbox 宿主）。
      // **拖拽中不收起**——底部预挂时宠物滑到窗口下方，用户仍要看到输入框。
      const edge = hitboxRef.current?.dataset.edge ?? 'none'
      const dragging = hitboxRef.current?.dataset.dragging === 'true'
      setEdgeAttached(edge !== 'none' && !dragging)
      // 与主进程 bubble 的抑制条件对齐：贴上/下边且非拖拽中（拖拽预挂不抑制气泡）
      topBottomEdgeRef.current = !dragging && (edge === 'top' || edge === 'bottom')
      // 宠物视觉包围盒（窗口坐标）：X11 setShape 会同时裁剪可见区域（verify-report 已知限制）——
      // 形状矩形必须 ≥ 形象渲染范围（含 SVG 表情符号如头顶 Zzz/"？"），否则形象被裁。
      // 调整形象尺寸 / 表情元素位置时，同步调整此值。
      // 宠物视觉包围盒（窗口坐标）：按 hitbox 实测矩形派生——缩放档位变化、贴边动作移动
      // 画布时都会自动跟随（不再写死 270×240 时代的 {8,0,254,208}）。左右各扩 7×scale
      // 覆盖表情/耳朵余量；上下不加（1.0x 时与旧值完全一致：x8,w254,y0,h208）。
      // X11 setShape 会同时裁剪可见区域，矩形必须覆盖完整形象。
      const rects: Rect[] = []
      const hb = hitboxRef.current?.getBoundingClientRect()
      if (hb && hb.width > 0 && hb.height > 0) {
        const margin = Math.round(7 * getPetScale())
        rects.push({
          x: Math.max(0, Math.round(hb.left) - margin),
          y: Math.round(hb.top),
          width: Math.round(hb.width) + margin * 2,
          height: Math.round(hb.height)
        })
      } else {
        // 兜底：hitbox 尚未布局（不应发生）
        rects.push({
          x: 8,
          y: 0,
          width: Math.max(1, window.innerWidth - 16),
          height: Math.round(208 * getPetScale())
        })
      }
      for (const el of [
        hitboxRef.current,
        chatPanelRef.current,
        statusBarRef.current,
        teachingBubblesRef.current,
        settingsGuideRef.current
      ]) {
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        rects.push({
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
        })
      }
      if (rects.length === 0) return
      bridge.window.reportInteractiveRects(rects)
      console.log(`[pet] interactive rects = ${JSON.stringify(rects)}`)
    }

    const report = (): void => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        doReport()
      })
    }

    report()
    const observers: ResizeObserver[] = []
    for (const el of [
      hitboxRef.current,
      chatPanelRef.current,
      statusBarRef.current,
      teachingBubblesRef.current,
      settingsGuideRef.current
    ]) {
      if (!el) continue
      const ro = new ResizeObserver(report)
      ro.observe(el)
      observers.push(ro)
    }
    window.addEventListener('resize', report)
    // 贴边动作会移动 hitbox 宿主（data-edge 变化，尺寸不变）：ResizeObserver 不触发，
    // 必须补发一次形状上报，否则新位置的模型收不到鼠标事件（X11 setShape 裁剪）
    const edgeObserver = new MutationObserver(report)
    if (hitboxRef.current) {
      edgeObserver.observe(hitboxRef.current, {
        attributes: true,
        attributeFilter: ['data-edge', 'data-dragging']
      })
    }
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      observers.forEach((ro) => ro.disconnect())
      edgeObserver.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [debugBarVisible, teachingExpanded, teachingState.mode, guideActive, workActive])

  return (
    <div className="app-root">
      {/* 顶部状态显示：宠物状态 + 当前情绪（开发向信息，默认隐藏；Ctrl+Shift+D 唤出）。
          条件渲染：隐藏时完全不占界面（absolute 定位，不影响宠物/对话面板布局） */}
      {debugBarVisible ? (
        <div className="pet-status-bar" data-testid="pet-status-bar">
          <span className="pet-state" data-testid="pet-state">
            {STATE_LABEL[petState]}
          </span>
          <span className="pet-emotion" data-testid="pet-emotion">
            {emotionEmoji(emotion)} {emotion}
          </span>
        </div>
      ) : null}

      {/* 宠物挂载容器（hitbox）：pet 域在此挂载当前渲染器（SVG 部件动画；将来可换 Live2D 画布）。
          注意：容器尺寸 = X11 交互形状（setInteractiveRects 上报），调整形象尺寸时需与之匹配 */}
      <div
        ref={hitboxRef}
        className={`pet-canvas-mount${debug.hitboxVisible ? ' debug' : ''}`}
        data-testid="pet-hitbox"
      >
        {/* 吸附特效（2026-10-20）：拖拽进入贴边范围时，沿屏幕边显示呼吸光带；
            松手后主进程缓动吸附到工作区边。方向/显隐由父级 data-edge + data-dragging 的 CSS 控制 */}
        <div className="edge-snap-glow" aria-hidden="true" />
        <PetView client={wsClient} />
      </div>

      {/* 对话域：输入框 + 气泡列表（订阅 WS token/emotion/reply_*）。
          教学模式展开态收起（内容都在黑板）；设置向导期间收起（只剩宠物 + 萌语气泡，§7.6.6）。
          收起期间消息/输入状态保留，折叠让路或退出即恢复 */}
      <ChatPanel
        client={wsClient}
        containerRef={chatPanelRef}
        hidden={teachingState.mode === 'teaching' || guideActive || workActive || edgeAttached}
      />

      {/* 教学模式：头顶问题气泡（课堂目录，最多 4 条 + "+N"；点击 → 黑板跳段）。
          仅展开态挂载（容器参与交互矩形上报）；让路态（折叠）隐藏 */}
      <TeachingBubbles
        items={teachingBubbles}
        visible={teachingExpanded}
        onClick={gotoTeachingBubble}
        containerRef={teachingBubblesRef}
      />

      {/* 设置向导：右眼右上方萌语气泡（§7.6.6；设置窗打开期间显示，飞位动画由主进程 ball-animation 编排）。
          纯视觉物（pointer-events:none），但可见时必须参与形状上报（X11 裁剪） */}
      <SettingsGuideBubble visible={guideActive} containerRef={settingsGuideRef} />

      {/* 底部调试栏（开发向信息，默认隐藏；Ctrl+Shift+D 唤出）。
          条件渲染并在隐藏时不挂 ref：交互矩形上报与 ResizeObserver 均跳过该容器 */}
      {debugBarVisible ? (
        <div className="status-bar" ref={statusBarRef}>
          <div>
            后端：{BACKEND_LABEL[backendState]} · WS：{WS_LABEL[wsState]}
            {voiceSpeaking ? <span className="status-speaking"> · 🔊 说话中</span> : null}
            {behaviorStatus
              ? ` · 🐾 ${behaviorStatus.name}${behaviorStatus.detail ? `（${behaviorStatus.detail}）` : ''}`
              : ''}
            {lastError ? <span className="status-error"> · ⚠ {lastError}</span> : null}
          </div>
          <div>
            穿透 {debug.clickThrough ? '开' : '关'} · 置顶 {debug.alwaysOnTop ? '开' : '关'} · hitbox{' '}
            {debug.hitboxVisible ? '显示' : '隐藏'} · F9/F10/F11 · W 走动 · N 打盹 · Ctrl+Shift+D
            调试栏
          </div>
        </div>
      ) : null}
    </div>
  )
}
