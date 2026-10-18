/**
 * 魔法球捕获动画（ball-animation 域）参数配置——**集中在此处调整，改这里即可改观感/时长**。
 *
 * 逃生门：`ENABLED = false` 时隐藏/显示退化为原本的 show()/hide() 瞬时切换
 * （不创建球窗、不播动画），用于动画出问题/不喜欢时的快速关停。
 *
 * 方案：**球窗**（ballWindowSize×ballWindowSize 的透明小窗，"球"本体）+ 移动球窗完成飞行；
 * 全屏透明层方案已弃用（避免遮挡用户其它操作）。
 * 视觉/运动设计整体移植自参考实现（magic-flight：二次贝塞尔拱线 + easeInOut 三次 +
 * 星屑尾迹 + 抵达爆散），视觉参数在渲染侧 `src/ball-animation/config.ts`（本文件只管窗口与时序）。
 *
 * 时序总览（隐藏方向，默认参数合计 ≈ 2.0s）：
 *   飞行（球窗沿拱线：托盘 → 宠物中心）   flightMs
 *   → 抵达爆散（粒子+光晕+扩散环；宠物原地缩小 + 挣扎反应）captureMs
 *   → 回程（球窗与缩小态的宠物**沿同一条拱线**一起飞回托盘）returnMs
 *   → 到达后宠物 hide + 球淡出收窗                        fadeMs
 * 显示方向（反向）：飞行（球窗载宠物剪影：托盘 → 原位拱线）flightMs
 *   → 释放爆散（宠物窗从缩小态放大归位）releaseMs → 淡出 fadeMs。
 */
export const BALL_ANIMATION_CONFIG = {
  /** 总开关（false = 直接 show/hide，无动画；改这里后重启应用生效） */
  ENABLED: true,

  /** 球窗边长（px）——球固定在窗中心；尾迹/爆散的视觉半径均按此收敛（上限 ~400，绝不全屏） */
  ballWindowSize: 360,

  // ---- 飞行曲线（照参考 magic-flight：二次贝塞尔，控制点向上拱起） ----
  /** 弧高系数：arc = clamp(距离 × arcFactor, arcMin, arcMax) */
  arcFactor: 0.32,
  /** 弧高下限（px） */
  arcMin: 70,
  /** 弧高上限（px） */
  arcMax: 240,
  /** 控制点距工作区顶部的安全边距（px）：防"向上拱"把球拱出屏顶导致中途看不见 */
  arcTopMargin: 60,

  // ---- 节奏（照参考：飞行 780ms + 抵达爆散 420ms） ----
  /** ① 飞行：球窗沿拱线从托盘锚点飞到宠物中心（ms） */
  flightMs: 780,
  /** ② 抵达爆散（捕获）：爆散时长；宠物窗口同步原地缩小到 shrinkScale（ms） */
  captureMs: 420,
  /** ③ 回程：球窗与缩小态的宠物一起沿拱线飞回托盘锚点（ms；略快于去程，收工利落感） */
  returnMs: 620,
  /** ④ 收尾淡出（ms）：到达托盘、宠物 hide 后，球窗淡出再隐藏 */
  fadeMs: 180,

  /** 显示方向：释放爆散 + 宠物窗从缩小态放大归位（ms；与抵达爆散同节奏） */
  releaseMs: 420,

  /** 宠物被捕获时缩到的比例（0.2 = 缩到 20%） */
  shrinkScale: 0.2,

  // ---- 应用生命周期演出（2026-10-18 用户定稿：启动飞入 / 退出飞出）----
  /**
   * 启动入场：球从**屏幕上方外**沿拱线俯冲下来 → 释放落地。起点固定在目标屏幕顶部之上
   * 一个球径处，水平位置 = 落点中心 + launchStartDxPx（负=落点左侧，正=右侧）——
   * 横向偏移越大，俯冲弧线越明显（0 = 正上方垂直落下，几乎看不出弧线）。
   */
  launchStartDxPx: -360,
  /**
   * 启动问候：落地释放后，宠物说的第一句话。
   * 固定本地文案，不经过后端（启动要可预期，LLM/TTS 首句延迟不可控）。
   */
  greetingText: '我来了~',
  /** 启动问候气泡停留（ms）；气泡域自动收起（悬浮/选区时暂停） */
  greetingTtlMs: 3000,
  /** 落地归位到开口问候之间的停顿（ms）：先"站定"再说话，节奏更自然 */
  greetingDelayMs: 200,
  /**
   * 启动时等待动画页就绪的上限（ms）：比通用 readyTimeoutMs 更短——
   * 宁可放弃飞入直接显示，也不能让冷启动黑屏等待太久。
   */
  launchReadyTimeoutMs: 1200,

  /**
   * 退出告别（仅托盘"退出"触发；系统关机等路径保持即时退出）：
   * 说"再见啦~" → 球原地凝聚 → 捕获爆闪 → 球载着宠物**沿弧线向上飞出屏幕** → 真正退出。
   */
  farewellText: '再见啦~',
  /** 告别气泡的展示等待（ms）：说完这句再开始捕获（同时与后端清理并行） */
  farewellSayMs: 1200,
  /** 告别气泡 TTL（ms）：略短于 farewellSayMs，让气泡在球凝聚时开始收起 */
  farewellTtlMs: 1000,
  /** 退出：球载宠沿弧线飞出屏幕顶部的时长（ms；easeIn 加速离场） */
  farewellFlyMs: 650,
  /** 退出：飞出时的水平弧线偏移（px；朝更近的一侧边缘，弧线更明显；0 = 垂直向上） */
  farewellArcDriftPx: 150,
  /** 退出流程等待在途动画收尾的上限（ms；超时则跳过告别直接退出） */
  farewellBusyWaitMs: 1500,

  /**
   * 移动动画（relocate，"原地凝聚起手"，2026-10-16 用户定稿）：球在宠物所在处
   * **原地凝聚显现**的时长（ms）——光点从无到有 + 微脉动，随后爆闪捕获
   * （保留完整魔法效果；与原实现唯一差别=不经过托盘锚点，球不走"从托盘飞来"的绕路）。
   */
  relocateSpawnMs: 250,

  // ---- 移动动画的距离分档（2026-10-16 用户定稿）----
  /**
   * 分档阈值（px；按"宠物当前位置 ↔ 向导位"的直线距离）：
   *   ≥ relocateMagicMinPx（远）：完整魔法（原地凝聚 → 捕获 → 携宠飞 → 释放）；
   *   ≥ relocateNearStepPx 且 < 上限（近）：**平滑移位**——宠物原样沿小弧滑过去，无球无爆闪
   *     （"离得很近就别表演整套魔法了"）；
   *   < relocateNearStepPx（太近）：直接落位（"太近了不用飞"，不折腾）。
   */
  relocateMagicMinPx: 300,
  relocateNearStepPx: 60,
  /** 近距平滑移位的时长（ms） */
  relocateGlideMs: 450,

  /**
   * 移动动画（relocate，设置向导 §7.6.6）等待在途动画收尾的上限（ms）。
   * 与 hide/show 的「忙则忽略」不同：向导入位/回位不可静默丢失，忙时短暂等待
   * （在途动画典型总长 ≤ totalTimeoutMs）；超过上限则放弃本次（日志警告）。
   */
  relocateBusyWaitMs: 7000,

  /** 等待 fx 动画页就绪的超时（ms）：超时则本次退化为直接 show/hide（不再创建/等待） */
  readyTimeoutMs: 2500,
  /** 整个动画流程的兜底超时（ms）：异常时强制收尾，保证 hide/show 一定生效 */
  totalTimeoutMs: 6000
} as const

/**
 * 托盘锚点**兜底值**（屏幕坐标 px）：仅在自动定位（抓屏+模板匹配，见 ball-animation/anchor.ts）失败时使用。
 * 实测环境：主屏 1920×1080（Deepin DDE，Dock 在底部；兔头图标位于 Dock 托盘区
 * 微信/云兔头/QQ 一组内，图标本体约 20px，取中心）。⚠ 托盘图标增删/布局变化会让它漂移——
 * 正常情况下**不依赖这个值**（自动定位每次实时找兔头）；换环境后如需更新兜底值：
 * 全屏截图 → 裁托盘区放大 → 读图标像素中心（方法见 docs/reports/frontend/2026-10-15-ball-animation.md）。
 * 覆盖方式（可不改代码）：环境变量 `PET_TRAY_ANCHOR="x,y"`（启动应用前设置，启动时读取）。
 */
export const TRAY_ANCHOR: { x: number; y: number } = resolveTrayAnchor()

/** 解析托盘锚点兜底值：环境变量 PET_TRAY_ANCHOR="x,y" 优先，非法值回退实测默认 */
function resolveTrayAnchor(): { x: number; y: number } {
  const fallback = { x: 1334, y: 1071 }
  const raw = process.env['PET_TRAY_ANCHOR']
  if (!raw) return fallback
  const parts = raw.split(',').map((s) => Number(s.trim()))
  if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
    return { x: Math.round(parts[0]!), y: Math.round(parts[1]!) }
  }
  console.warn(`[ball-animation] PET_TRAY_ANCHOR 格式无效（应为 "x,y"）："${raw}"，使用实测默认锚点`)
  return fallback
}
