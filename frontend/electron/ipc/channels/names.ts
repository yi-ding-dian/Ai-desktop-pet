/**
 * IPC 通道名（主进程 ↔ 渲染进程的单一事实来源）。
 *
 * 本文件只含常量（不 import electron 运行时），preload / 渲染侧可安全引用。
 */

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
  /** 查询宠物窗是否可见（invoke → boolean；提醒在隐藏时转系统通知，2026-10-18） */
  WINDOW_IS_VISIBLE: 'window:is-visible',
  /** 无边框窗口：标题栏拖动移位（payload: FramelessMovePayload；start/move/end 三阶段） */
  WINDOW_CHROME_MOVE: 'window:chrome-move',
  /** 无边框窗口：四边/四角拖动改尺寸（payload: FramelessResizePayload；只动被拖的边） */
  WINDOW_CHROME_RESIZE: 'window:chrome-resize',
  /** 查询系统空闲秒数（invoke → number；powerMonitor.getSystemIdleTime） */
  SYSTEM_GET_IDLE_SECONDS: 'system:get-idle-seconds',
  /** 显示系统通知（payload: {title, body}；提醒在宠物隐藏/教学/向导中补发，2026-10-18） */
  SYSTEM_NOTIFY: 'system:notify',
  /** 用系统默认浏览器打开 http/https 外链（invoke(url) → OpenResult；记忆本 open_item） */
  SYSTEM_OPEN_EXTERNAL: 'system:open-external',
  /** 用默认程序打开本机文件/文件夹（invoke(path) → OpenResult；可执行/脚本类拒绝） */
  SYSTEM_OPEN_PATH: 'system:open-path',
  /** 宠物面：删除本机文件/文件夹——先弹气泡确认，确认后移入回收站（2026-10-18） */
  SYSTEM_DELETE_PATH_CONFIRM: 'system:delete-path-confirm',
  /** 宠物面：清理磁盘白名单缓存——先弹气泡确认，确认后移入回收站（2026-10-22） */
  SYSTEM_CLEAN_DISK_CONFIRM: 'system:clean-disk-confirm',
  /** 设置面：删除本机文件/文件夹——主进程原生确认框，确认后移入回收站 */
  SETTINGS_DELETE_PATH: 'settings:delete-path',
  /** 列出已安装应用（invoke → LauncherListResult；launcher 域，2026-10-19） */
  LAUNCHER_LIST_APPS: 'launcher:list-apps',
  /** 启动本机程序（invoke → LauncherRunResult；launcher 域，2026-10-19） */
  LAUNCHER_RUN: 'launcher:run',
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
  /** 教学模式：查询状态（invoke → TeachingStatePayload） */
  TEACHING_GET_STATE: 'teaching:get-state',
  /** 空气让路（§5.1 增补）：渲染侧回报光标处命中判定（payload: {solid: boolean}；false=空气 → 主进程输入让路） */
  PET_REPORT_HIT_TEST: 'pet:report-hit-test',
  /** 宠物缩放：应用档位（invoke(scale) → PetScaleApplyResult；设置窗保存时调用，主进程改窗口尺寸并持久化） */
  PET_SET_SCALE: 'pet:set-scale',
  /** 宠物缩放：查询当前档位（invoke → number；设置窗打开时校准显示值） */
  PET_GET_SCALE: 'pet:get-scale',
  /** 设置窗口：请求打开独立设置窗口（托盘菜单与聊天关键词共用；单例，重复打开则聚焦已有） */
  SETTINGS_OPEN: 'settings:open',
  /** 设置窗口：请求重启应用（设置页"重启"按钮；主进程先走后端退出清理再 relaunch） */
  APP_RESTART: 'app:restart',
  /** 设置窗口：保存成功上报（设置面 → 主；主进程据此触发宠物向导飞回原位） */
  SETTINGS_SAVED: 'settings:saved',
  /** 文件分析：打开原生文件选择框（invoke → PickedFile[]；取消返回空数组） */
  FILES_PICK: 'files:pick',
  /** 文件分析：粘贴路径时校验（invoke(path) → PickedFile | null；只 stat，不读正文） */
  FILES_STAT: 'files:stat',
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
  /** 窗口贴边状态变化（窗口移动时实时推送，仅在变化时发；payload: PetWindowEdge） */
  WINDOW_EDGE_CHANGED: 'window:edge-changed',
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
  PET_POINTER_POS: 'pet:pointer-pos',
  /** 气泡说话生命周期（主 → 宠物窗；payload: BubbleSpeechEventPayload；提醒气泡关闭/已读时更新未读列表） */
  BUBBLE_SPEECH_EVENT: 'bubble:speech-event',
  /** 提醒列表动作（主 → 宠物窗；payload: ReminderListActionPayload；列表点条目/全部已读时回传） */
  REMINDER_LIST_ACTION: 'reminder-list:action-request',
  /** 生命周期台词（主 → 宠物窗；payload: PetSayLinePayload；启动"我来了~"/退出"再见啦~"经说话气泡展示） */
  PET_SAY_LINE: 'pet:say-line',
  /** 宠物缩放档位变化（主 → 宠物窗；payload: number；渲染层据此更新 CSS 变量） */
  PET_SCALE_CHANGED: 'pet:scale-changed'
} as const

/** 通道名：魔法球捕获动画（ball-animation 域：主进程 ↔ fx 动画页） */
export const IPC_BALL_ANIMATION = {
  /** fx 动画页 → 主：动画页已就绪（首帧可接收指令） */
  READY: 'ball-animation:ready',
  /** 主 → fx 动画页：动画指令（payload: BallAnimationCommand，单通道多指令类型） */
  COMMAND: 'ball-animation:command'
} as const

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
  /** 宠物窗 → 主：回复气泡空闲自动收起时长（payload: number 秒；0=不自动收） */
  SET_IDLE_TTL: 'bubble:set-idle-ttl',
  /** 宠物窗 → 主：只覆盖下一轮说话的空闲收起时长（payload: number 毫秒；本地 5s 短提示用） */
  SET_NEXT_SPEECH_TTL: 'bubble:set-next-speech-ttl',
  /** 宠物窗 → 主：用户发送了新消息，重置当前回复气泡的空闲计时（气泡保留到新回复替换） */
  SPEECH_TOUCH: 'bubble:speech-touch',
  /** 气泡窗 → 主：悬浮/选中文字等交互（payload: { paused: boolean }；暂停期间不计自动收起） */
  SPEECH_ACTIVITY: 'bubble:speech-activity',
  /** 气泡窗 → 主：右键请求复制菜单（payload: { selectionText: string }；复制后气泡保持） */
  REQUEST_CONTEXT_MENU: 'bubble:request-context-menu',
  /** 主 → 气泡窗：同 session 内容更新（payload: BubbleUpdatePayload；只换文字不重播入场——说话气泡流式刷新） */
  UPDATE: 'bubble:update'
} as const

/**
 * 提醒列表窗（2026-10-18）：贴在宠物右侧的未读提醒面板。
 * 数据流同气泡/黑板先例——宠物窗（WS 连接方）把未读快照发给主进程，主进程摆窗并转发；
 * 列表页只做展示与动作回报，不自己连 WS。
 */
export const IPC_REMINDER_LIST = {
  /** 宠物窗 → 主：未读快照（payload: ReminderListUpdatePayload；items 空 = 隐藏） */
  UPDATE: 'reminder-list:update',
  /** 列表窗 → 主：渲染就绪（主进程收到后补发内容） */
  READY: 'reminder-list:ready',
  /** 列表窗 → 主：内容尺寸上报（payload: {width,height}；主进程据此调窗/防出屏） */
  REPORT_SIZE: 'reminder-list:report-size',
  /** 列表窗 → 主：用户动作（ack / ack-all / expand） */
  ACTION: 'reminder-list:action',
  /** 列表窗 → 主：请求右键菜单（“全部已读”） */
  CONTEXT_MENU: 'reminder-list:context-menu',
  /** 主 → 列表窗：内容/显隐（payload: ReminderListOpenPayload） */
  OPEN: 'reminder-list:open'
} as const

/**
 * 工作模式（2026-10-18）：独立聊天窗。
 *
 * 数据流与教学黑板同型——宠物窗是唯一 WS 连接方，工作窗经主进程中继收发：
 *  - 工作窗 → 主 → 宠物窗：发送 / 打断 / 历史请求；
 *  - 宠物窗 → 主 → 工作窗：对话镜像 / 历史响应；
 *  - 主 → 宠物窗：窗口存在性（决定是否镜像）。
 */
export const IPC_WORK = {
  /** 渲染/菜单 → 主：打开工作窗（单例，已存在则聚焦） */
  OPEN: 'work:open',
  /** 工作窗 → 主：隐藏（不销毁，保留记录） */
  HIDE: 'work:hide',
  /**
   * 工作窗 → 主：最小化 = 折叠到屏幕右缘中间的小角标（2026-10-20 用户需求：
   * 像黑板折叠那样吸附在窗口最右侧中间，不进任务栏/桌面图标）。
   */
  MINIMIZE: 'work:minimize',
  /** 工作窗 → 主：展开（点击折叠角标恢复原窗口） */
  UNFOLD: 'work:unfold',
  /** 主 → 工作窗：折叠态变化（true = 已折叠成角标，渲染侧换角标 UI） */
  FOLDED: 'work:folded',
  /** 工作窗 → 主：渲染就绪（主进程在此之前缓冲事件） */
  READY: 'work:ready',
  /** 工作窗 → 主：发送（invoke → WorkSendResultPayload） */
  REQUEST_SEND: 'work:request-send',
  /** 主 → 宠物窗：发送请求（宠物面执行 sendUserMessage） */
  SEND_REQUEST: 'work:send-request',
  /** 宠物窗 → 主：发送结果（回给 invoke） */
  SEND_RESULT: 'work:send-result',
  /** 工作窗 → 主 → 宠物窗：打断（payload: {sessionId}；缺省前台会话） */
  INTERRUPT: 'work:interrupt',
  /** 工作窗 → 主 → 宠物窗：切换前台对话（决定宠物气泡/语音跟谁） */
  FOCUS_CONVERSATION: 'work:focus-conversation',
  /** 主 → 宠物窗：切换前台对话 */
  FOCUS_CONVERSATION_REQUEST: 'work:focus-conversation-request',
  /** 工作窗 → 主：删除单条消息（payload: {dbId}） */
  DELETE_MESSAGE: 'work:delete-message',
  /** 主 → 宠物窗：删除单条消息（宠物面发 WS delete_message） */
  DELETE_MESSAGE_REQUEST: 'work:delete-message-request',
  /** 工作窗 → 主：在内嵌浏览器打开一个链接 */
  BROWSER_OPEN: 'work:browser-open',
  /** 工作窗 → 主：关闭内嵌浏览器标签 */
  BROWSER_CLOSE: 'work:browser-close',
  /** 工作窗 → 主：切换到某标签（null = 对话） */
  BROWSER_ACTIVATE: 'work:browser-activate',
  /** 工作窗 → 主：浏览器工具条动作 */
  BROWSER_ACTION: 'work:browser-action',
  /** 工作窗 → 主：DOM 浮层（+N 标签菜单）打开时临时隐藏原生网页视图，避免被盖住 */
  BROWSER_OVERLAY: 'work:browser-overlay',
  /** 主 → 工作窗：标签列表/激活态 */
  BROWSER_STATE: 'work:browser-state',
  /** 宠物窗 → 主：对话镜像事件 */
  REPORT_EVENT: 'work:report-event',
  /** 主 → 工作窗：对话镜像事件 / 历史响应 */
  EVENT: 'work:event',
  /** 工作窗 → 主：历史请求（invoke → WorkHistoryPayload） */
  REQUEST_HISTORY: 'work:request-history',
  /** 主 → 宠物窗：历史请求 */
  HISTORY_REQUEST: 'work:history-request',
  /** 宠物窗 → 主：历史响应 */
  HISTORY: 'work:history',
  /** 工作窗 → 主：对话列表（invoke → WorkConversationsPayload） */
  REQUEST_CONVERSATIONS: 'work:request-conversations',
  /** 主 → 宠物窗：对话列表请求 */
  CONVERSATIONS_REQUEST: 'work:conversations-request',
  /** 宠物窗 → 主：对话列表响应 */
  CONVERSATIONS: 'work:conversations',
  /** 工作窗 → 主：改对话标题（invoke） */
  RENAME_CONVERSATION: 'work:rename-conversation',
  /** 主 → 宠物窗：改标题请求 */
  RENAME_CONVERSATION_REQUEST: 'work:rename-conversation-request',
  /** 宠物窗 → 主：改标题响应 */
  CONVERSATION_RENAMED: 'work:conversation-renamed',
  /** 工作窗 → 主：删除对话（invoke） */
  DELETE_CONVERSATION: 'work:delete-conversation',
  /** 主 → 宠物窗：删除对话请求 */
  DELETE_CONVERSATION_REQUEST: 'work:delete-conversation-request',
  /** 宠物窗 → 主：删除对话响应 */
  CONVERSATION_DELETED: 'work:conversation-deleted',
  /** 主 → 宠物窗：工作窗是否存在（true 时宠物面才镜像） */
  PRESENCE: 'work:presence',
  /** 宠物窗 → 主：查询工作窗当前是否存在（宠物窗重载后补状态，invoke → WorkPresencePayload） */
  GET_PRESENCE: 'work:get-presence',
  /** 主 → 工作窗：宠物窗重载完成（清空旧记录、重新拉历史） */
  PET_READY: 'work:pet-ready',
  /** 工作窗：最大化 ⇄ 复原（填充当前显示器工作区；2026-10-23） */
  MAXIMIZE_TOGGLE: 'work:maximize-toggle',
  /** 工作窗：查询是否处于最大化（invoke → boolean） */
  IS_MAXIMIZED: 'work:is-maximized',
  /** 主 → 工作窗：最大化状态变化（payload: boolean） */
  MAXIMIZED: 'work:maximized'
} as const

/**
 * 任务模式通道（2026-10-23）：「工作窗 → 任务」标签页与主进程 agent 域的协议。
 *
 * 对话模式完全不受影响——本组通道只服务任务面板。
 */
export const IPC_AGENT = {
  /** 开始任务（invoke（AgentStartPayload）→ {ok, error?}；立即返回，执行在后台） */
  START: 'agent:start',
  /** 中止任务（id；缺省仍兼容旧渲染侧 = 当前任务） */
  CANCEL: 'agent:cancel',
  /** 继续追问（invoke（AgentFollowUpPayload）→ {ok, error?}；沿用同一个 Agent 与上下文） */
  FOLLOW_UP: 'agent:follow-up',
  /** 读取图片附件为 data URL（invoke（path）→ string | null；仅用于缩略图预览） */
  PREVIEW: 'agent:preview',
  /** 查询当前状态（invoke → AgentState；面板晚挂载时补状态） */
  GET_STATE: 'agent:get-state',
  /** 选择工作区（invoke → string | null；主进程原生文件夹对话框） */
  PICK_WORKSPACE: 'agent:pick-workspace',
  /** 回应确认卡（payload: AgentApprovePayload） */
  APPROVE: 'agent:approve',
  /** 回答提问卡（payload: AgentQuestionAnswerPayload） */
  ANSWER_QUESTION: 'agent:answer-question',
  /** 切换执行模式（payload: AgentSetModePayload） */
  SET_MODE: 'agent:set-mode',
  /** 计划任务「按此执行」（payload: AgentExecutePlanPayload） */
  EXECUTE_PLAN: 'agent:execute-plan',
  /** 主 → 工作窗：通知点击后切到指定任务（payload: id） */
  FOCUS_TASK: 'agent:focus-task',
  /** 主 → 工作窗：状态推送（payload: AgentState，节流 ~120ms） */
  STATE: 'agent:state',
  /** 拉取任务列表（invoke → AgentTaskSummary[]） */
  GET_TASKS: 'agent:get-tasks',
  /** 切换当前任务（invoke（id）→ {ok, error?}） */
  SELECT: 'agent:select',
  /** 删除任务（invoke（id）→ {ok, error?}；运行中的先中止） */
  DELETE: 'agent:delete',
  /** 工作窗 → 主：任务面板是否正在显示（含工作窗可见性）；用于完成未读标记 */
  PANEL_ACTIVE: 'agent:panel-active',
  /** 主 → 工作窗：任务列表变化（payload: AgentTaskSummary[]） */
  TASKS: 'agent:tasks',
  /** 查询当前生效的默认工作区（invoke → string；配置无效时 reject 可读原因） */
  GET_DEFAULT_WORKSPACE: 'agent:get-default-workspace',
  /** 查询平台默认工作区路径（只计算不建目录；设置页占位提示用） */
  GET_PLATFORM_WORKSPACE: 'agent:get-platform-workspace',
  /** 把当前目录设为默认（invoke（path）→ {ok, error?}；写回 config.toml） */
  SET_DEFAULT_WORKSPACE: 'agent:set-default-workspace',
  /** 宠物窗 → 主：把带文件的消息转成任务草稿（invoke → {ok, error?}） */
  DRAFT_TASK: 'agent:draft-task',
  /** 主 → 工作窗：任务草稿已就绪（payload: AgentTaskDraftPayload） */
  TASK_DRAFT: 'agent:task-draft'
} as const
