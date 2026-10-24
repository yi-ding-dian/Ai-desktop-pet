/** preload 通过 contextBridge 暴露给渲染进程的白名单 API（window.pet）。 */
import type { MoveResult, Point, Rect, WindowGeometry } from '../../window'
import type {
  AgentApprovePayload,
  AgentExecutePlanPayload,
  AgentFollowUpPayload,
  AgentQuestionAnswerPayload,
  AgentSetModePayload,
  AgentStartPayload,
  AgentState,
  AgentTaskSummary
} from './agent'
import type {
  BallAnimationCommand,
  BallAnimationPetReactionPayload,
  PetSayLinePayload
} from './ball-animation'
import type { BackendReadyPayload, BackendSnapshot, BackendStatusPayload } from './backend'
import type {
  BubbleOpenPayload,
  BubbleRequest,
  BubbleSpeechEventPayload,
  BubbleSpeechMeta,
  BubbleTail,
  BubbleUpdatePayload
} from './bubble'
import type { PickedFile } from './files'
import type {
  LauncherListRequest,
  LauncherListResult,
  LauncherRunRequest,
  LauncherRunResult
} from './launcher'
import type {
  ReminderListActionPayload,
  ReminderListOpenPayload,
  ReminderListUpdatePayload
} from './reminder'
import type { SettingsVisibilityPayload, TrayMenuAction } from './settings'
import type { CleanDiskResult, DeletePathResult, OpenResult } from './system'
import type {
  TeachingBoardInbox,
  TeachingEnterReason,
  TeachingMirrorEvent,
  TeachingSendRequestPayload,
  TeachingStatePayload
} from './teaching'
import type {
  FramelessMovePayload,
  FramelessResizePayload,
  PetScaleApplyResult,
  WindowDebugState,
  WindowEdgePayload
} from './window'
import type {
  WorkBrowserAction,
  WorkBrowserOpenPayload,
  WorkBrowserState,
  WorkConversationDeletedPayload,
  WorkConversationRenamedPayload,
  WorkConversationsPayload,
  WorkConversationsRequestPayload,
  WorkDeleteConversationRequestPayload,
  WorkHistoryPayload,
  WorkHistoryRequestPayload,
  WorkMirrorEvent,
  WorkPresencePayload,
  WorkRenameConversationRequestPayload,
  WorkSendRequestPayload,
  WorkSendResultPayload
} from './work'

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
    /** 查询宠物窗当前是否可见（提醒在隐藏时转系统通知，2026-10-18） */
    isVisible(): Promise<boolean>
    /** 订阅窗口几何变化（主进程已 debounce ~1s）；返回取消订阅函数 */
    onGeometryChanged(cb: (geo: WindowGeometry) => void): () => void
    /** 订阅窗口贴边状态变化（移动时实时推送，仅变化时发）；返回取消订阅函数 */
    onEdgeChanged(cb: (payload: WindowEdgePayload) => void): () => void
    /** 空气让路：上报光标处命中判定（true=实体/交互元素，false=空气透明区）——主进程据此输入让路/恢复 */
    reportHitTest(solid: boolean): void
    /** 空气让路：订阅主进程推送的光标窗口内坐标（仅让路态轮询推送；null=光标不在窗口内）；返回取消订阅函数 */
    onPointerPos(cb: (pos: { x: number; y: number } | null) => void): () => void
    /** 宠物缩放：查询当前档位（设置窗打开时校准显示值；主进程为运行时真相源） */
    getPetScale(): Promise<number>
    /** 宠物缩放：应用档位（设置窗保存时调用；主进程改窗口尺寸并持久化） */
    setPetScale(scale: number): Promise<PetScaleApplyResult>
    /** 宠物缩放：订阅档位变化（宠物窗据此更新 CSS 变量）；返回取消订阅函数 */
    onPetScaleChanged(cb: (scale: number) => void): () => void
  }
  /**
   * 无边框窗口通用拖动/缩放（2026-10-18 窗口 UI 套件）：
   * 只有主进程 `attachFrameless` 注册过的窗口（当前为黑板）生效；未注册窗口的调用被忽略。
   * 视觉热区/标题栏由 shared/ui 的 WindowTitleBar / WindowResizeHandles 提供。
   */
  frameless: {
    /** 标题栏拖动移位（start → move* → end） */
    move(payload: FramelessMovePayload): void
    /** 四边/四角拖动改尺寸（拖动中高频上报目标尺寸 + 拖动的边） */
    resize(payload: FramelessResizePayload): void
  }
  /** 系统状态（env_update 上报依据） */
  system: {
    /** 系统空闲秒数（用户多久没有键鼠操作） */
    getIdleSeconds(): Promise<number>
    /**
     * 显示一条系统通知（提醒功能 v1）：宠物隐藏 / 教学 / 设置向导中无法弹气泡时补发；
     * 主进程走 Electron Notification（跨平台，无平台分支）。
     */
    notify(title: string, body: string): void
    /** 用系统默认浏览器打开 http/https 外链（只放行 http/https；2026-10-18 记忆本） */
    openExternal(url: string): Promise<OpenResult>
    /** 写系统剪贴板（工作模式复制消息；preload 直接调 Electron clipboard） */
    copyText(text: string): void
    /** 用默认程序打开本机文件/文件夹（可执行/脚本类拒绝；2026-10-18 记忆本） */
    openPath(path: string): Promise<OpenResult>
    /**
     * 宠物面：删除本机文件/文件夹——先从宠物头部弹「删除 / 取消」确认气泡，
     * 再弹一次「再次确认 / 取消」（2026-10-23 敏感删除二次确认）；两次都确认后
     * 才把目标移入系统回收站（可恢复）。任意一次取消/超时什么都不做。
     */
    deletePathWithConfirm(path: string, name?: string): Promise<DeletePathResult>
    /**
     * 宠物面：清理磁盘白名单缓存——先从宠物头部弹「清理 / 取消」确认气泡，
     * 用户点清理后才把内容移入系统回收站（可恢复；占用中的文件跳过）。
     * 只传白名单 key（来自 disk_report）；主进程自行解析路径，不接受任意路径。
     */
    cleanDiskWithConfirm(keys: string[]): Promise<CleanDiskResult>
  }
  /**
   * 程序启动（launcher 域，2026-10-19）：
   * - `listApps`：设置页「从已安装应用中选择」用；
   * - `runProgram`：按名启动已安装应用，或按路径启动可执行文件
   *   （记忆本 `trusted=true` 免确认；临时路径由主进程弹确认气泡）。
   */
  launcher: {
    listApps(request?: LauncherListRequest): Promise<LauncherListResult>
    runProgram(request: LauncherRunRequest): Promise<LauncherRunResult>
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
   * 应用生命周期演出（2026-10-18）：启动落地问候 / 退出告别。
   * 只发宠物窗口；台词固定本地文案，渲染侧收到后经说话气泡展示（不依赖后端）。
   */
  lifecycle: {
    /** 订阅生命周期台词（payload: PetSayLinePayload）；返回取消订阅函数 */
    onSay(cb: (payload: PetSayLinePayload) => void): () => void
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
    /** 黑板面：输入条发送（主进程路由给宠物窗口执行 WS 发送；attachments 只传路径/显示名） */
    requestSend(text: string, attachments?: { path: string; name: string }[]): void
    /** 宠物面：订阅"黑板输入条发送请求"（黑板打字 → 主进程路由 → 宠物面执行 WS 发送）；返回取消订阅函数 */
    onSendRequest(cb: (payload: TeachingSendRequestPayload) => void): () => void
    /** 黑板面：角标点击请求恢复展开 */
    requestUnfold(): void
    /** 黑板面：渲染就绪（主进程收到后下发首批数据） */
    ready(): void
    /** 黑板面：订阅收件箱（镜像 / 跳转 / 显隐命令）；返回取消订阅函数 */
    onBoardInbox(cb: (item: TeachingBoardInbox) => void): () => void
  }
  /** 文件分析（P1）：原生选择框 + 粘贴路径/拖拽校验（都不读正文） */
  files: {
    /** 打开原生文件选择框（多选；取消返回空数组） */
    pick(): Promise<PickedFile[]>
    /** 校验一个路径是否是普通文件（粘贴路径/拖拽用；只 stat，不读正文） */
    stat(path: string): Promise<PickedFile | null>
    /**
     * 拖入的 File → 本地绝对路径（Electron 32+ 的 webUtils.getPathForFile；
     * 浏览器内生成的文件/无路径对象返回空串）。
     */
    pathFor(file: File): string
  }
  /** 设置窗口（P4 前置）：宠物面请求打开独立设置窗口 */
  settings: {
    /** 请求打开设置窗口（宠物窗口调用；托盘菜单与聊天关键词"打开设置"共用入口；单例——已打开则聚焦） */
    open(): void
    /** 设置面：保存成功上报（主进程据此触发宠物向导飞回原位） */
    notifySaved(): void
    /** 宠物面：订阅设置窗显示状态（向导编排——面板收起/萌语气泡/回位）；返回取消订阅函数 */
    onVisibility(cb: (payload: SettingsVisibilityPayload) => void): () => void
    /**
     * 设置面：删除本机文件/文件夹——主进程用原生确认框（删除/取消），
     * 确认后才移入系统回收站。返回与宠物面同一结构。
     */
    deletePath(path: string): Promise<DeletePathResult>
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
    sayBegin(meta?: BubbleSpeechMeta): void
    /** 宠物面：说话气泡文本快照（全文覆盖式更新；渲染侧已节流，主进程转发气泡窗走同 session UPDATE） */
    sayText(text: string): void
    /** 宠物面：说话结束（缺省按字数停留后自动收；immediate=true 被打断立即收） */
    sayEnd(immediate?: boolean): void
    /** 宠物面：回复气泡空闲自动收起时长（秒；0=不自动收）；设置保存后即时同步 */
    setIdleTimeout(seconds: number): void
    /** 宠物面：只覆盖下一轮说话的空闲收起时长（毫秒；不支持文件的 5s 短提示用） */
    setNextSpeechTtl(ms: number): void
    /** 宠物面：用户发送新消息，重置当前回复气泡的空闲计时（不改变气泡文本） */
    touchSpeech(): void
    /** 气泡面：悬浮/选中文字 → 暂停自动收起；移开/取消选区 → 恢复计时 */
    reportSpeechActivity(paused: boolean): void
    /** 气泡面：右键请求复制菜单（传当前选中文本；主进程弹原生菜单，复制不收起气泡） */
    requestContextMenu(selectionText: string): void
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
    /** 宠物面：订阅提醒气泡生命周期（关闭进未读列表 / 已读回执）；返回取消订阅函数 */
    onSpeechEvent(cb: (payload: BubbleSpeechEventPayload) => void): () => void
  }
  /** 提醒列表窗（2026-10-18）：宠物面推送未读快照；主进程摆窗/转发动作 */
  reminderList: {
    /** 宠物面：更新未读快照（items 空或 visible=false → 隐藏列表窗） */
    update(payload: ReminderListUpdatePayload): void
    /** 列表面：渲染就绪（主进程收到后补发内容） */
    ready(): void
    /** 列表面：内容尺寸上报（主进程据此调窗/防出屏） */
    reportSize(size: { width: number; height: number }): void
    /** 列表面：用户动作（ack / ack-all / expand） */
    action(payload: ReminderListActionPayload): void
    /** 列表面：请求右键菜单（主进程弹出“全部已读”） */
    contextMenu(): void
    /** 列表面：订阅内容（主进程 OPEN）；返回取消订阅函数 */
    onOpen(cb: (payload: ReminderListOpenPayload) => void): () => void
    /** 宠物面：订阅列表页用户动作（ack / ack-all / expand）；返回取消订阅函数 */
    onAction(cb: (payload: ReminderListActionPayload) => void): () => void
  }
  /**
   * 工作模式（独立聊天窗，2026-10-18）。
   *  - 宠物面/托盘/菜单：open；
   *  - 工作窗：hide/minimize/ready/requestSend/requestHistory/interrupt + onEvent/onPetReady；
   *  - 宠物面：onSendRequest/sendResult/onHistoryRequest/reportHistory/onInterrupt/onPresence。
   * 方法与窗口不匹配的调用在 main 侧按 sender 过滤，是安全空操作。
   */
  /** 任务模式（2026-10-23）：工作窗「任务」标签页 */
  agent: {
    /** 开始任务（校验失败时 ok=false 并给出原因） */
    start(payload: AgentStartPayload): Promise<{ ok: boolean; error?: string }>
    /** 中止指定任务（id 必填；后台任务也能停） */
    cancel(id: string): Promise<{ ok: boolean; error?: string }>
    /** 继续追问（同一任务上下文；运行中作为插话） */
    followUp(payload: AgentFollowUpPayload): Promise<{ ok: boolean; error?: string }>
    /** 图片附件缩略图（data URL；非图片/过大返回 null） */
    previewImage(path: string): Promise<string | null>
    /** 查询当前任务状态（面板挂载时补状态） */
    getState(): Promise<AgentState>
    /** 弹原生文件夹对话框选工作区（取消返回 null） */
    pickWorkspace(): Promise<string | null>
    /** 回应确认卡（用户点允许/拒绝） */
    approve(payload: AgentApprovePayload): void
    /** 回答提问卡 */
    answerQuestion(payload: AgentQuestionAnswerPayload): Promise<{ ok: boolean; error?: string }>
    /** 切换执行模式 */
    setMode(payload: AgentSetModePayload): Promise<{ ok: boolean; error?: string }>
    /** 计划任务「按此执行」 */
    executePlan(payload: AgentExecutePlanPayload): Promise<{ ok: boolean; error?: string }>
    /** 订阅「切到某个任务」（通知点击）；返回取消订阅函数 */
    onFocusTask(cb: (id: string) => void): () => void
    /** 订阅任务状态；返回取消订阅函数 */
    onState(cb: (state: AgentState) => void): () => void
    /** 任务列表（左侧栏） */
    getTasks(): Promise<AgentTaskSummary[]>
    /** 切换当前任务 */
    select(id: string): Promise<{ ok: boolean; error?: string }>
    /** 任务面板是否正在显示（工作窗可见时）；用于完成未读标记 */
    panelActive(active: boolean): void
    /** 删除任务（运行中的先中止） */
    deleteTask(id: string): Promise<{ ok: boolean; error?: string }>
    /** 订阅任务列表变化；返回取消订阅函数 */
    onTasks(cb: (tasks: AgentTaskSummary[]) => void): () => void
  }
  work: {
    /** 打开工作窗（单例；已存在则 show + focus） */
    open(): void
    /** 工作窗：隐藏（保留记录与滚动位置） */
    hide(): void
    /** 工作窗：最小化 = 折叠到屏幕右缘中间的角标（不进任务栏） */
    minimize(): void
    /** 工作窗：展开（点击折叠角标恢复原窗口） */
    unfold(): void
    /** 工作窗：最大化 ⇄ 复原 */
    maximizeToggle(): void
    /** 工作窗：查询最大化状态（面板挂载时校准按钮图标） */
    isMaximized(): Promise<boolean>
    /** 工作窗：订阅最大化状态变化；返回取消订阅函数 */
    onMaximizedChanged(cb: (maximized: boolean) => void): () => void
    /** 工作窗：订阅折叠态变化；返回取消订阅函数 */
    onFolded(cb: (folded: boolean) => void): () => void
    /** 工作窗：渲染就绪 */
    ready(): void
    /** 工作窗：发送一条用户消息（invoke → 结果） */
    requestSend(payload: WorkSendRequestPayload): Promise<WorkSendResultPayload>
    /** 工作窗：请求历史回填（invoke → 历史 + 缓冲事件 + live 快照） */
    requestHistory(payload: WorkHistoryRequestPayload): Promise<WorkHistoryPayload>
    /** 工作窗：对话列表（invoke） */
    requestConversations(
      payload: WorkConversationsRequestPayload
    ): Promise<WorkConversationsPayload>
    /** 工作窗：改对话标题（invoke） */
    renameConversation(
      payload: WorkRenameConversationRequestPayload
    ): Promise<WorkConversationRenamedPayload>
    /** 工作窗：删除对话（invoke） */
    deleteConversation(
      payload: WorkDeleteConversationRequestPayload
    ): Promise<WorkConversationDeletedPayload>
    /** 工作窗：打断当前回复 */
    interrupt(): void
    /** 工作窗：删除单条消息（按后端 DB 行 id；删除结果经 onEvent 的 message_deleted 回传） */
    deleteMessage(payload: { dbId: number; sessionId?: string }): void
    /** 工作窗：在内嵌浏览器打开链接（已有同 URL 标签则切换过去） */
    browserOpen(payload: WorkBrowserOpenPayload): void
    /** 工作窗：关闭内嵌浏览器标签 */
    browserClose(id: string): void
    /** 工作窗：切换标签（null = 对话） */
    browserActivate(id: string | null): void
    /** 工作窗：浏览器工具条动作（后退/前进/刷新/系统浏览器） */
    browserAction(action: WorkBrowserAction): void
    /** 工作窗：临时隐藏/恢复原生网页视图（DOM 下拉菜单浮在网页上方时用） */
    browserOverlay(open: boolean): void
    /** 工作窗：订阅内嵌浏览器状态；返回取消订阅函数 */
    onBrowserState(cb: (state: WorkBrowserState) => void): () => void
    /** 工作窗：订阅镜像事件；返回取消订阅函数 */
    onEvent(cb: (event: WorkMirrorEvent) => void): () => void
    /** 工作窗：订阅“宠物窗重载完成”（应清空旧记录并重新拉历史）；返回取消订阅函数 */
    onPetReady(cb: () => void): () => void
    /** 宠物面：上报镜像事件（主进程转发给工作窗；工作窗存在时才调用） */
    reportEvent(event: WorkMirrorEvent): void
    /** 宠物面：订阅发送请求（工作窗打字 → 主进程路由 → 宠物面执行 WS 发送）；返回取消订阅函数 */
    onSendRequest(cb: (payload: WorkSendRequestPayload) => void): () => void
    /** 宠物面：回执发送结果 */
    sendResult(payload: WorkSendResultPayload): void
    /** 宠物面：订阅历史请求；返回取消订阅函数 */
    onHistoryRequest(cb: (payload: WorkHistoryRequestPayload) => void): () => void
    /** 宠物面：回执历史（含缓冲事件与 live 快照） */
    reportHistory(payload: WorkHistoryPayload): void
    /** 宠物面：订阅对话列表请求；返回取消订阅函数 */
    onConversationsRequest(cb: (payload: WorkConversationsRequestPayload) => void): () => void
    /** 宠物面：回执对话列表 */
    reportConversations(payload: WorkConversationsPayload): void
    /** 宠物面：订阅改标题请求；返回取消订阅函数 */
    onRenameConversationRequest(
      cb: (payload: WorkRenameConversationRequestPayload) => void
    ): () => void
    /** 宠物面：回执改标题 */
    reportConversationRenamed(payload: WorkConversationRenamedPayload): void
    /** 宠物面：订阅删除对话请求；返回取消订阅函数 */
    onDeleteConversationRequest(
      cb: (payload: WorkDeleteConversationRequestPayload) => void
    ): () => void
    /** 宠物面：回执删除对话 */
    reportConversationDeleted(payload: WorkConversationDeletedPayload): void
    /** 宠物面：订阅打断请求；返回取消订阅函数 */
    onInterrupt(cb: () => void): () => void
    /** 宠物面：订阅删除单条消息请求；返回取消订阅函数 */
    onDeleteMessage(cb: (payload: { dbId: number; sessionId?: string }) => void): () => void
    /** 宠物面：订阅工作窗存在性；返回取消订阅函数 */
    onPresence(cb: (payload: WorkPresencePayload) => void): () => void
    /** 宠物面：查询工作窗当前是否存在（重载后补状态） */
    getPresence(): Promise<WorkPresencePayload>
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
