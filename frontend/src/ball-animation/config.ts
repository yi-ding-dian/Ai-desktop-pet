/**
 * 魔法球动画页（ball-animation.html）视觉参数——**颜色/粒子/尺寸集中在这里调**。
 * 数值与运动设计整体移植自参考实现（magic-flight：贝塞尔拱线 + easeInOut 三次 +
 * 星屑尾迹 + 抵达爆散），按球窗尺寸做紧凑化适配。
 *
 * 约束（重要）：球窗只有 ballWindowSize×ballWindowSize（见 electron/ball-animation/config.ts，默认 360），
 * **画到窗口外的内容会被裁掉**——尾迹长度/爆散半径都按此收敛；
 * "球的飞行"由主进程移动窗口完成（沿贝塞尔拱线），本页面里球**固定**在窗口中心，
 * 尾迹/星屑按"窗口位移的反向"在窗内滑动，还原"球飞过留下一路星屑"的观感。
 */
export const BALL_ANIMATION_VISUAL = {
  /**
   * 星屑/爆散的颜色池（青 → 紫 → 粉 → 白；与参考 magic-flight 完全一致）
   */
  colors: ['#7dd3fc', '#a78bfa', '#f0abfc', '#fda4af', '#ffffff'] as const,

  // ---- 核心光球（参考：17px 半径径向渐变光点；载宠时略胀） ----
  /** 球体渐变的半径（px） */
  ballRadius: 17,
  /** 载宠（回程）时球体半径的放大倍数 */
  cargoBallScale: 1.5,
  /** 球体外圈紫色系光晕半径（px；在球窗内） */
  haloRadius: 64,

  // ---- 尾迹线（参考：由细到粗 0.6→4.2、青色→白色（后 28% 转白）、shadowBlur 发光） ----
  trail: {
    /** 尾迹点上限（参考 16 点跨屏可用；球窗内紧凑化为 8 点） */
    maxPoints: 8,
    /** 尾迹最大跨度（px；超出从最老端裁剪——球在窗心，最长画到窗内 ~150px） */
    maxSpanPx: 150,
    /** 线宽：最细/最粗 */
    widthMin: 0.6,
    widthMax: 4.2,
    /** 转白阈值（a 为该线段在新旧序列中的位置 0→1） */
    whiteAt: 0.72,
    /** shadowBlur 发光半径（px）与颜色 */
    shadowBlur: 9,
    shadowColor: '#7dd3fc'
  },

  // ---- 星屑粒子（参考：每帧 3 颗、随机速度、vy 轻微下坠、寿命 0.35~0.65s、阻尼 0.98/帧） ----
  dust: {
    /** 飞行中每帧撒下颗数 */
    spawnPerFrame: 3,
    /** 生成位置的随机散布（px） */
    spawnSpread: 5,
    /** 随机速度上限（px/帧 @60fps） */
    spawnSpeed: 0.9,
    /** vy 附加的"下坠"常量（px/帧） */
    gravity: 0.25,
    /** 寿命范围（秒） */
    lifeS: [0.35, 0.65] as const,
    /** 粒子半径基准范围（px） */
    radius: [1.2, 2.8] as const,
    /** 每帧阻尼（0.98 = 强阻尼） */
    damping: 0.98
  },

  // ---- 抵达爆散（参考：30 颗径向粒子 + 收敛光晕 + 扩散环 6→32px；时长 420ms 由主进程节奏控制） ----
  burst: {
    /** 径向爆散粒子数（参考 30） */
    particles: 30,
    /** 径向速度范围（px/帧 @60fps：参考 1.6~4.0） */
    speed: [1.6, 4.0] as const,
    /** 爆散粒子寿命范围（秒；参考 0.45~0.75） */
    lifeS: [0.45, 0.75] as const,
    /** 爆散粒子半径基准范围（px；参考 1.2~3.0） */
    radius: [1.2, 3.0] as const,
    /** 收敛光晕：参考 rad = 26×(1-b×0.6)、渐隐；b∈[0,1] 为爆散进度 */
    haloRadius: 26,
    haloShrink: 0.6,
    /** 扩散环：半径 6 + b×26、线宽 2(1-b)+0.5（照参考） */
    ringStart: 6,
    ringSpan: 26,
    /** 爆散表现时长（ms；与主进程 captureMs/releaseMs 对齐——之后听下一条指令） */
    durationMs: 420
  },

  /** 淡出（主进程 fade-out 指令）默认时长兜底（ms） */
  fadeFallbackMs: 180
} as const
