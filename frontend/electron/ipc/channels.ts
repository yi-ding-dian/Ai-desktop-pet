/**
 * IPC 通道定义（主进程 ↔ 渲染进程的单一事实来源）。
 *
 * 本文件只含常量与纯类型（不 import electron 运行时），preload / 渲染侧可安全引用。
 */
import type { MoveResult, Point, Rect, WindowGeometry } from '../window'

/** 通道名：渲染 → 主（send / invoke） */
export const IPC = {
  /** 设置点击穿透（boolean） */
  WINDOW_SET_CLICK_THROUGH: 'window:set-click-through',
  /** 开始拖拽（payload: Point，拖拽起始光标的屏幕坐标） */
  WINDOW_DRAG_START: 'window:drag-start',
  /** 拖拽移动（payload: Point，当前光标屏幕坐标；由渲染侧 pointer capture + pointermove 驱动） */
  WINDOW_DRAG_MOVE: 'window:drag-move',
  /** 结束拖拽 */
  WINDOW_DRAG_END: 'window:drag-end',
  /** 渲染侧上报窗口可交互矩形（payload: Rect[]，相对窗口左上角，DIP） */
  WINDOW_REPORT_INTERACTIVE_RECTS: 'window:report-interactive-rects',
  /** 查询窗口调试状态（invoke → WindowDebugState） */
  WINDOW_GET_DEBUG_STATE: 'window:get-debug-state',
  /** 缓动移动窗口到屏幕坐标（invoke (x, y, durationMs) → MoveResult；P3 行为引擎） */
  WINDOW_MOVE_TO: 'window:move-to',
  /** 取消进行中的缓动移动（无 payload） */
  WINDOW_MOVE_CANCEL: 'window:move-cancel',
  /** 查询窗口几何（invoke → WindowGeometry；行为执行 + env 上报用） */
  WINDOW_GET_GEOMETRY: 'window:get-geometry',
  /** 查询系统空闲秒数（invoke → number；powerMonitor.getSystemIdleTime） */
  SYSTEM_GET_IDLE_SECONDS: 'system:get-idle-seconds',
  /** 查询后端状态快照（invoke → BackendSnapshot；渲染进程晚订阅时补状态） */
  BACKEND_GET_SNAPSHOT: 'backend:get-snapshot',
  /** 教学模式：请求进入（payload: TeachingEnterReason；宠物面"关键词"或内部） */
  TEACHING_ENTER: 'teaching:enter',
  /** 教学模式：请求退出（宠物面"下课"关键词 / 黑板面 × 按钮共用；主进程按 sender 识别来源） */
  TEACHING_EXIT: 'teaching:exit',
  /** 教学模式：宠物面上报镜像事件（payload: TeachingMirrorEvent，主进程路由给黑板） */
  TEACHING_REPORT_MIRROR: 'teaching:report-mirror',
  /** 教学模式：请求黑板跳转（payload: messageId，点击头顶问题气泡） */
  TEACHING_GOTO: 'teaching:goto',
  /** 教学模式：拖拽开始（无 payload；教学模式中触发黑板折叠让路） */
  TEACHING_DRAG_START: 'teaching:drag-start',
  /** 教学模式：黑板输入条发送（payload: text，主进程路由给宠物窗口执行 WS 发送） */
  TEACHING_REQUEST_SEND: 'teaching:request-send',
  /** 教学模式：黑板角标点击请求恢复展开（无 payload） */
  TEACHING_REQUEST_UNFOLD: 'teaching:request-unfold',
  /** 教学模式：黑板渲染就绪（主进程收到后下发首批数据） */
  TEACHING_READY: 'teaching:ready',
  /** 教学模式：黑板左缘拖动改宽（payload: number 目标宽度px；主进程夹取范围 → 黑板 setBounds（右缘固定）+ 宠物同帧跟随；仅展开态有效） */
  TEACHING_BOARD_RESIZE: 'teaching:board-resize',
  /** 教学模式：查询状态（invoke → TeachingStatePayload） */
  TEACHING_GET_STATE: 'teaching:get-state',
  /** 空气让路（§5.1 增补）：渲染侧回报光标处命中判定（payload: {solid: boolean}；false=空气 → 主进程输入让路） */
  PET_REPORT_HIT_TEST: 'pet:report-hit-test',
  /** 设置窗口：请求打开独立设置窗口（托盘菜单与聊天关键词共用；单例，重复打开则聚焦已有） */
  SETTINGS_OPEN: 'settings:open',
  /** 设置窗口：请求重启应用（设置页"重启"按钮；主进程先走后端退出清理再 relaunch） */
  APP_RESTART: 'app:restart',
  /** 设置窗口：保存成功上报（设置面 → 主；主进程据此触发宠物向导飞回原位） */
  SETTINGS_SAVED: 'settings:saved',
  /** 自绘托盘菜单：菜单项动作（菜单窗 → 主；payload: TrayMenuAction，执行后主进程收起菜单） */
  TRAY_MENU_ACTION: 'tray-menu:action',
  /** 气泡系统：请求弹出气泡（payload: BubbleRequest；宠物窗右键 = 'menu' 菜单；主进程定位+防出屏后弹出气泡窗） */
  BUBBLE_REQUEST_OPEN: 'bubble:request-open'
} as const

/** 通道名：主 → 渲染（webContents.send 广播） */
export const IPC_EVENTS = {
  /** 调试状态变化（调试快捷键触发后推送） */
  WINDOW_DEBUG_STATE_CHANGED: 'window:debug-state-changed',
  /** 切换调试栏显隐（Ctrl+Shift+D 全局快捷键触发后推送；渲染侧翻转本地显隐状态） */
  WINDOW_TOGGLE_DEBUG_BAR: 'window:toggle-debug-bar',
  /** 窗口几何变化（移动/缩放后 debounce ~1s 推送；payload: WindowGeometry） */
  WINDOW_GEOMETRY_CHANGED: 'window:geometry-changed',
  /** 后端子进程状态变化（payload: BackendStatusPayload） */
  BACKEND_STATUS_CHANGED: 'backend:status-changed',
  /** 后端就绪（payload: BackendReadyPayload，含 WS 端口与 hello token） */
  BACKEND_READY: 'backend:ready',
  /** 魔法球动画：宠物遭到捕获/释放（payload: BallAnimationPetReactionPayload；只发宠物窗口，渲染侧播 captured/released 反应） */
  PET_FX_REACTION: 'pet:fx-reaction',
  /** 教学模式：状态广播（payload: TeachingStatePayload；双端都收——宠物面走位/气泡/面板，黑板面视图） */
  TEACHING_STATE_CHANGED: 'teaching:state-changed',
  /** 教学模式：黑板收件箱（payload: TeachingBoardInbox；只发黑板窗口，单通道多指令，先例见 IPC_BALL_ANIMATION.COMMAND） */
  TEACHING_BOARD_INBOX: 'teaching:board-inbox',
  /** 教学模式：黑板输入条发送请求（payload: {text}；只发宠物窗口，宠物面收到后执行 WS user_message 发送） */
  TEACHING_SEND_REQUEST: 'teaching:send-request',
  /** 设置窗显示状态变化（payload: SettingsVisibilityPayload；只发宠物窗口——向导编排：面板收起/萌语气泡/回位） */
  SETTINGS_VISIBILITY: 'settings:visibility',
  /** 自绘托盘菜单：初始化载荷（payload: {petVisible: boolean}；菜单窗每次弹出前下发，驱动「显示/隐藏宠物」文案） */
  TRAY_MENU_INIT: 'tray-menu:init',
  /** 气泡系统：请求清空聊天（只发宠物窗口；气泡确认【清空】后主进程发出——chat 域收到后执行清空，本期只留占位） */
  CHAT_CLEAR_REQUESTED: 'chat:clear-requested',
  /** 空气让路：光标窗口内坐标推送（payload: {x,y} | null（null=光标不在窗口内）；仅让路态轮询推送——渲染侧据此判定是否恢复接管） */
  PET_POINTER_POS: 'pet:pointer-pos'
} as const

/** 通道名：魔法球捕获动画（ball-animation 域：主进程 ↔ fx 动画页） */
export const IPC_BALL_ANIMATION = {
  /** fx 动画页 → 主：动画页已就绪（首帧可接收指令） */
  READY: 'ball-animation:ready',
  /** 主 → fx 动画页：动画指令（payload: BallAnimationCommand，单通道多指令类型） */
  COMMAND: 'ball-animation:command'
} as const

/**
 * fx 动画指令（主进程为指挥，fx 球窗页面只负责"画"；球固定在球窗中心，
 * 飞行 = 主进程移动球窗本身——指令不需要坐标，只有表现状态）。
 */
export type BallAnimationCommand =
  | { type: 'reset' }
  /** 原地凝聚显现：球体在窗口中心从无到有（光点渐入 + 微脉动），durationMs 由主进程计时——到点发下一条指令 */
  | { type: 'spawn'; durationMs: number }
  /** 进入飞行表现（拖尾/公转星点；cargo=true 时球内载宠物剪影——去程空载、回程携带） */
  | { type: 'flight'; cargo: boolean }
  /** 捕获爆闪：球心爆闪并吸附脉动（球窗原地停留 holdMs，期间宠物窗口缩小） */
  | { type: 'capture-burst'; holdMs: number }
  /** 释放爆闪：球炸开、光芒散开（显示方向） */
  | { type: 'release-burst' }
  /** 整层淡出（durationMs 后主进程隐藏球窗） */
  | { type: 'fade-out'; durationMs: number }

/** 宠物反应事件载荷（主 → 宠物窗口渲染进程） */
export interface BallAnimationPetReactionPayload {
  /** captured = 被魔法球抓住（隐藏动画）；released = 被放回原位（显示动画） */
  kind: 'captured' | 'released'
}

// ------------------------------------------------------------------ 气泡系统（气泡窗域）

/**
 * 通道名：气泡系统（主进程 bubble 域 ↔ 气泡窗 bubble.html；请求入口在宠物面）。
 * 分工：主进程为指挥（定位/防出屏/两态/动作分发），气泡窗只负责"画"与本地动画
 * （入场"手来手回"在窗内播，播毕经 CLOSED 回报，主进程再 hide——照 IPC_BALL_ANIMATION 先例）。
 */
export const IPC_BUBBLE = {
  /** 气泡窗 → 主：渲染就绪（React 挂载完成，可接收内容；窗口重建后复位重报） */
  READY: 'bubble:ready',
  /** 气泡窗 → 主：内容尺寸上报（payload: {width,height}；主进程据此 setBounds 动态调窗 + 防出屏重定位） */
  REPORT_SIZE: 'bubble:report-size',
  /**
   * 气泡窗 → 主：内容交互矩形上报（payload: Rect[]，窗内坐标）——说话气泡要悬浮（出现 展开/✕ 工具条）
   * 就得接鼠标；用窗口形状（win.setShape，宠物窗"空气让路"同款）把输入区裁到"气泡 + 工具条区"，
   * 其余透明区域保持完全穿透（不挡桌面）。**Linux 与 Windows 都走这条**（setShape 的平台标注即
   * win32+linux）；未收到上报时主进程保持整窗默认（旧渲染/浏览器调试下功能仍通，只是透明区挡点击）。
   */
  REPORT_SHAPE: 'bubble:report-shape',
  /** 气泡窗 → 主：用户动作（payload: string，项 id / 确认取消；主进程按当前内容白名单校验后分发执行） */
  ACTION: 'bubble:action',
  /** 气泡窗 → 主：退场动画播毕（窗口可 hide；主进程隐藏并复位——用户点击/失焦收起都走"先播后报"） */
  CLOSED: 'bubble:closed',
  /** 主 → 气泡窗：打开/换内容（payload: BubbleOpenPayload；每次下发重播入场动画） */
  OPEN: 'bubble:open',
  /** 主 → 气泡窗：请求收起（渲染侧播退场动画后回报 CLOSED；主进程有超时兜底强制 hide） */
  REQUEST_CLOSE: 'bubble:request-close',
  /** 主 → 气泡窗：尾巴朝向更新（payload: BubbleTail；尺寸上报引发翻向时下发，仅换样式不重播动画） */
  SET_TAIL: 'bubble:set-tail',
  /** 宠物窗 → 主：说话气泡出现（回复开始；气泡显于兔子头部旁，文本随后经 SAY_TEXT 流式刷新） */
  SAY_BEGIN: 'bubble:say-begin',
  /** 宠物窗 → 主：说话气泡文本快照（payload: BubbleSayTextPayload；渲染侧节流后发全文覆盖） */
  SAY_TEXT: 'bubble:say-text',
  /** 宠物窗 → 主：说话结束（payload: BubbleSayEndPayload；缺省=按字数停留后自动收，immediate=被打断立即收） */
  SAY_END: 'bubble:say-end',
  /** 主 → 气泡窗：同 session 内容更新（payload: BubbleUpdatePayload；只换文字不重播入场——说话气泡流式刷新） */
  UPDATE: 'bubble:update'
} as const

/** 尾巴朝向：down = 尾巴在气泡左下角（气泡悬于锚点上方，指向下方的宠物）；up = 翻向（气泡在锚点下方） */
export type BubbleTail = 'down' | 'up'

/**
 * 运动预设：
 *  - hand = 手来手回（小光点从爪子方向飞入展开 / 退场收回——右键菜单、清空确认用）；
 *  - light = 轻量展开（气泡自尾巴处弹性绽放 / 收拢淡出，无光点——说话气泡用，高频不闹）；
 *  - none = 直接显隐（预留）。
 */
export type BubbleMotion = {
  enter: 'hand' | 'light' | 'none' | 'instant'
  exit: 'hand' | 'light' | 'none' | 'instant'
}

/** 气泡形态预设（menu = 右键菜单；confirm = 清空确认；text = 说话气泡——聊天回复展示在兔子头部旁） */
export type BubbleVariant = 'menu' | 'confirm' | 'text'

/** 菜单项载荷（icon = shared/icons 的图标名——'teaching' | 'settings' | 'broom' | 'sleep'；未知名渲染为无图标） */
export interface BubbleMenuItemPayload {
  id: string
  label: string
  icon?: string
}

/**
 * 气泡打开载荷（主 → 气泡窗）。
 * session：弹出会话序号（主进程递增）——主进程在 show 后延迟补发同载荷一次（防 React 订阅前丢首帧），
 * 渲染侧按 session 去重（重复只认不重播动画）。tail 由主进程定位计算给出（防出屏翻向）。
 */
export type BubbleOpenPayload = {
  session: number
  tail: BubbleTail
  motion: BubbleMotion
  /**
   * 窗口是否复用（Windows 策略）：true = 跳过"尺寸稳定 → 强制重绘重挂载"。
   * 该重挂载是 Linux/KWin 残屏的补偿；在复用窗口上会在入场动画约 320ms 处再重渲染一次，
   * 观感像"分两段弹出"（2026-10-17 用户反馈）。
   */
  stableWindow?: boolean
} & (
  | { variant: 'menu'; items: BubbleMenuItemPayload[] }
  | { variant: 'confirm'; message: string; confirmLabel: string; cancelLabel: string }
  | { variant: 'text'; message: string }
)

/** 气泡请求（渲染面 → 主）：本期只有宠物窗右键菜单一种入口 */
export type BubbleRequest = { kind: 'menu' }

/** 说话气泡文本快照载荷（宠物面 → 主；全文覆盖式更新——渲染侧已节流，主进程转发气泡窗） */
export interface BubbleSayTextPayload {
  text: string
}

/** 说话气泡结束载荷（宠物面 → 主）：immediate = 被打断，不等停留立即收 */
export interface BubbleSayEndPayload {
  immediate?: boolean
}

/** 同 session 内容更新载荷（主 → 气泡窗；说话气泡流式刷新——只换文字不重播入场，尺寸变化由既有 REPORT_SIZE 链路重摆） */
export interface BubbleUpdatePayload {
  session: number
  message: string
}

// ------------------------------------------------------------------ 教学模式（P5，设计文档 §7.5）

/** 进入教学模式的触发来源（日志/调试用）；'bubble' = 说话气泡悬浮条的「展开」（带聊天记录进教学） */
export type TeachingEnterReason = 'menu' | 'keyword' | 'debug' | 'bubble'

/** 教学模式状态（主进程为唯一权威；两渲染面只读） */
export interface TeachingStatePayload {
  mode: 'normal' | 'teaching'
  /** 仅 mode=teaching 有意义：黑板是否处于折叠（角标）态 */
  folded: boolean
  /** 讲台位目标屏幕坐标（进入/恢复教学模式时给出；宠物面据此走位） */
  podium?: Point
  /** 状态变化原因（'menu' | 'keyword' | 'drag' | 'unfold' | 'exit' | 'ready' 等，日志用） */
  reason?: string
}

/**
 * 镜像事件（宠物面 → 主 → 黑板面）：
 * 对话主体仍在宠物窗口的 WS 连接上，黑板是"哑显示"——宠物面收到这些事件后镜像一份。
 */
export type TeachingMirrorEvent =
  | { kind: 'user_message'; text: string }
  | { kind: 'reply_start'; messageId: string }
  | { kind: 'token'; messageId: string; text: string }
  | { kind: 'reply_end'; messageId: string; fullText: string; interrupted: boolean }
  | { kind: 'history'; messages: { id: string; role: 'user' | 'assistant'; text: string }[] }

/** 黑板收件箱指令（主 → 黑板面；单通道多指令） */
export type TeachingBoardInbox =
  | { type: 'mirror'; event: TeachingMirrorEvent }
  | { type: 'goto'; messageId: string }
  /** expand = 卷出恢复；fold = 折叠成角标；exit = 退出教学模式（滑出收起） */
  | { type: 'visibility'; action: 'expand' | 'fold' | 'exit' }

// ------------------------------------------------------------------ 设置向导宠物（P4，设计文档 §7.6.6）与自绘托盘菜单（§7.6.4）

/** 设置窗显示状态（主 → 宠物窗；驱动向导 UI——飞位动画由主进程 ball-animation 域编排，宠物面只做响应） */
export type SettingsVisibilityPhase = 'opened' | 'saved' | 'closed'

/** SETTINGS_VISIBILITY 推送载荷 */
export interface SettingsVisibilityPayload {
  /** opened = 设置窗打开（宠物已飞至向导位：收起面板+萌语气泡）；saved/closed = 已触发飞回原位（气泡收起+面板恢复） */
  phase: SettingsVisibilityPhase
}

/** 自绘托盘菜单项动作（菜单窗 → 主；主进程执行后收起菜单窗） */
export type TrayMenuAction = 'toggle-pet' | 'teaching' | 'settings' | 'quit'

/** 后端子进程状态（设计文档 §5.2 状态机；IPC 广播取值） */
export type BackendState = 'starting' | 'ready' | 'failed' | 'stopped'

/** backend:status-changed 推送载荷（不含端口/token，连接信息只随 ready 事件下发） */
export interface BackendStatusPayload {
  state: BackendState
  /** 失败/重启等补充说明（供 UI 展示与排障） */
  message?: string
}

/** backend:ready 推送载荷：渲染侧据此建立 WS 连接（port + token） */
export interface BackendReadyPayload {
  port: number
  token: string
  pid: number
  /** 应用版本（app.getVersion()），hello.app_version 使用，与后端做版本握手 */
  appVersion: string
}

/** 后端状态快照（invoke backend:get-snapshot；覆盖渲染进程晚于 ready 订阅的场景） */
export interface BackendSnapshot extends BackendStatusPayload {
  port?: number
  token?: string
  pid?: number
  appVersion: string
}

/** 窗口调试状态快照（渲染侧状态栏展示） */
export interface WindowDebugState {
  clickThrough: boolean
  alwaysOnTop: boolean
  hitboxVisible: boolean
}

/**
 * preload 通过 contextBridge 暴露给渲染进程的白名单 API（window.pet）。
 * 渲染进程只能看到本接口，不得感知底层通道名与平台实现（设计文档 §1.1 核心原则 1）。
 */
export interface PetBridgeApi {
  /** 运行平台（'linux' | 'win32' | 'darwin' | ...），用于 UI 提示 */
  platform: string
  window: {
    /** 设置点击穿透 */
    setClickThrough(on: boolean): void
    /** 开始拖拽（参数为 pointerdown 事件的光标屏幕坐标） */
    startDrag(cursor: Point): void
    /** 拖拽移动（参数为 pointermove 事件的光标屏幕坐标） */
    dragMove(cursor: Point): void
    /** 结束拖拽 */
    endDrag(): void
    /** 上报窗口可交互矩形（宠物 hitbox 等；Linux 用作 X11 形状穿透的输入区） */
    reportInteractiveRects(rects: Rect[]): void
    /** 查询调试状态 */
    getDebugState(): Promise<WindowDebugState>
    /** 订阅调试状态变化；返回取消订阅函数 */
    onDebugStateChanged(cb: (state: WindowDebugState) => void): () => void
    /**
     * 订阅"调试栏显隐切换"事件（主进程 Ctrl+Shift+D 全局快捷键触发；渲染侧翻转本地显隐状态）；
     * 返回取消订阅函数
     */
    onToggleDebugBar(cb: () => void): () => void
    /** 缓动移动窗口到屏幕坐标 (x, y)；完成或被 cancelMove() 取消后 resolve（P3 行为引擎） */
    moveTo(x: number, y: number, durationMs: number): Promise<MoveResult>
    /** 取消进行中的缓动移动（用户交互打断行为时调用） */
    cancelMove(): void
    /** 查询窗口几何（位置/尺寸/工作区；行为执行与 env 上报用） */
    getGeometry(): Promise<WindowGeometry>
    /** 订阅窗口几何变化（主进程已 debounce ~1s）；返回取消订阅函数 */
    onGeometryChanged(cb: (geo: WindowGeometry) => void): () => void
    /** 空气让路：上报光标处命中判定（true=实体/交互元素，false=空气透明区）——主进程据此输入让路/恢复 */
    reportHitTest(solid: boolean): void
    /** 空气让路：订阅主进程推送的光标窗口内坐标（仅让路态轮询推送；null=光标不在窗口内）；返回取消订阅函数 */
    onPointerPos(cb: (pos: { x: number; y: number } | null) => void): () => void
  }
  /** 系统状态（env_update 上报依据） */
  system: {
    /** 系统空闲秒数（用户多久没有键鼠操作） */
    getIdleSeconds(): Promise<number>
  }
  /**
   * 魔法球捕获动画（ball-animation 域）：
   *  - fx 动画页（ball-animation.html）用 ready/onCommand 与主进程通信；
   *  - 宠物窗口用 onPetReaction 接收"被抓/被放"反应事件。
   */
  ballAnimation: {
    /** fx 动画页专用：通知主进程"动画页已就绪，可接收指令" */
    ready(): void
    /** fx 动画页专用：订阅主进程动画指令；返回取消订阅函数 */
    onCommand(cb: (cmd: BallAnimationCommand) => void): () => void
    /** 宠物窗口专用：订阅"被抓/被放"反应事件（隐藏/显示动画触发）；返回取消订阅函数 */
    onPetReaction(cb: (payload: BallAnimationPetReactionPayload) => void): () => void
  }
  /**
   * 教学模式（P5，设计文档 §7.5）：讲台 + 黑板形态。
   *  - 宠物面（pet 窗口）：enter/exit/reportMirror/goto/notifyDragStart + onState；
   *  - 黑板面（?surface=board）：requestSend/requestUnfold/ready/exit + onBoardInbox/onState。
   * 注："黑板面专属"的方法在宠物面调用、"宠物面专属"在黑板面调用均为无害空操作（主进程按 sender 过滤）。
   */
  teaching: {
    /** 查询当前教学模式状态（invoke → TeachingStatePayload） */
    getState(): Promise<TeachingStatePayload>
    /** 订阅教学模式状态变化（两个面都可用）；返回取消订阅函数 */
    onState(cb: (state: TeachingStatePayload) => void): () => void
    /** 宠物面：请求进入教学模式（reason: 'menu' 托盘 / 'keyword' 聊天关键词） */
    enter(reason: TeachingEnterReason): void
    /** 请求退出教学模式（宠物面"下课"关键词 / 黑板面 × 按钮共用） */
    exit(): void
    /** 宠物面：上报镜像对话事件（主进程路由给黑板） */
    reportMirror(event: TeachingMirrorEvent): void
    /** 宠物面：请求黑板跳转到某消息（点击头顶问题气泡） */
    goto(messageId: string): void
    /** 宠物面：拖拽开始（教学模式中触发黑板折叠让路；非教学模式主进程忽略） */
    notifyDragStart(): void
    /** 黑板面：输入条发送（主进程路由给宠物窗口执行 WS 发送） */
    requestSend(text: string): void
    /** 黑板面：左缘拖动改宽（拖动中高频上报目标宽度；主进程夹取范围、右缘固定、宠物同帧跟随） */
    resizeBoard(width: number): void
    /** 宠物面：订阅"黑板输入条发送请求"（黑板打字 → 主进程路由 → 宠物面执行 WS 发送）；返回取消订阅函数 */
    onSendRequest(cb: (payload: { text: string }) => void): () => void
    /** 黑板面：角标点击请求恢复展开 */
    requestUnfold(): void
    /** 黑板面：渲染就绪（主进程收到后下发首批数据） */
    ready(): void
    /** 黑板面：订阅收件箱（镜像 / 跳转 / 显隐命令）；返回取消订阅函数 */
    onBoardInbox(cb: (item: TeachingBoardInbox) => void): () => void
  }
  /** 设置窗口（P4 前置）：宠物面请求打开独立设置窗口 */
  settings: {
    /** 请求打开设置窗口（宠物窗口调用；托盘菜单与聊天关键词"打开设置"共用入口；单例——已打开则聚焦） */
    open(): void
    /** 设置面：保存成功上报（主进程据此触发宠物向导飞回原位） */
    notifySaved(): void
    /** 宠物面：订阅设置窗显示状态（向导编排——面板收起/萌语气泡/回位）；返回取消订阅函数 */
    onVisibility(cb: (payload: SettingsVisibilityPayload) => void): () => void
  }
  /** 应用级操作（设置页用） */
  app: {
    /** 请求重启应用（主进程先走后端退出清理链，再 relaunch——防孤儿后端进程） */
    restart(): void
  }
  /** 自绘托盘菜单窗（主题跟随；§7.6.4） */
  trayMenu: {
    /** 菜单窗 → 主：执行菜单项动作（主进程执行后收起菜单窗） */
    action(a: TrayMenuAction): void
    /** 菜单窗：订阅每次弹出前的初始化载荷（{petVisible}——驱动「显示/隐藏宠物」文案）；返回取消订阅函数 */
    onInit(cb: (payload: { petVisible: boolean }) => void): () => void
  }
  /**
   * 气泡系统（独立透明气泡窗）：
   *  - 宠物面：requestOpen 请求弹出（右键菜单等入口）+ 说话气泡三件套 sayBegin/sayText/sayEnd
   *    （聊天回复展示在兔子头部旁；定位/防出屏/两态/停留收起全在主进程）；
   *  - 气泡面（bubble.html）：ready/reportSize/action/notifyClosed + onOpen/onRequestClose/onSetTail/onUpdate。
   */
  bubble: {
    /** 宠物面：请求弹出气泡（主进程定位+防出屏（窗随内容动）+防重窗；重复请求收敛为刷新） */
    requestOpen(request: BubbleRequest): void
    /** 宠物面：说话气泡出现（回复开始；气泡显于兔子头部旁，纯展示态不抢焦点/不挡鼠标） */
    sayBegin(): void
    /** 宠物面：说话气泡文本快照（全文覆盖式更新；渲染侧已节流，主进程转发气泡窗走同 session UPDATE） */
    sayText(text: string): void
    /** 宠物面：说话结束（缺省按字数停留后自动收；immediate=true 被打断立即收） */
    sayEnd(immediate?: boolean): void
    /** 气泡面：渲染就绪（React 挂载完成；主进程收到后补发内容，防订阅前丢首帧） */
    ready(): void
    /** 气泡面：上报内容尺寸（ResizeObserver 驱动；主进程据此 setBounds 动态调窗） */
    reportSize(size: { width: number; height: number }): void
    /** 气泡面：上报内容交互矩形（说话气泡悬浮交互用；Linux 主进程据此 setShape 裁输入区，其余穿透） */
    reportShape(rects: Rect[]): void
    /** 气泡面：用户动作（项 id / 确认取消；主进程按当前内容校验后分发） */
    action(id: string): void
    /** 气泡面：退场动画播毕（主进程隐藏窗口并复位） */
    notifyClosed(): void
    /** 气泡面：订阅打开/换内容载荷（每次下发重播入场）；返回取消订阅函数 */
    onOpen(cb: (payload: BubbleOpenPayload) => void): () => void
    /** 气泡面：订阅同 session 内容更新（说话气泡流式刷新；只换文字不重播入场）；返回取消订阅函数 */
    onUpdate(cb: (payload: BubbleUpdatePayload) => void): () => void
    /** 气泡面：订阅收起请求（渲染侧播退场动画后 notifyClosed）；返回取消订阅函数 */
    onRequestClose(cb: () => void): () => void
    /** 气泡面：订阅尾巴朝向更新（防出屏翻向；仅换样式）；返回取消订阅函数 */
    onSetTail(cb: (tail: BubbleTail) => void): () => void
  }
  /** 对话域（chat） */
  chat: {
    /** 宠物面：订阅"请求清空聊天"（气泡确认【清空】后主进程发出；清空逻辑归后续任务，本期占位）；返回取消订阅函数 */
    onClearRequested(cb: () => void): () => void
  }
  /** 后端子进程（设计文档 §5.2）：状态订阅 + 快照查询；渲染进程不直接管理进程 */
  backend: {
    /** 查询当前状态快照（含 ready 时的 port/token，用于渲染进程晚订阅的补状态） */
    getSnapshot(): Promise<BackendSnapshot>
    /** 订阅后端状态变化；返回取消订阅函数 */
    onStatusChanged(cb: (status: BackendStatusPayload) => void): () => void
    /** 订阅后端就绪（port + token 下发，渲染侧据此建立 WS 连接）；返回取消订阅函数 */
    onReady(cb: (payload: BackendReadyPayload) => void): () => void
  }
}
