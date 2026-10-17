/**
 * 灰度模板匹配（NCC，归一化互相关）——用于"托盘兔头图标"的屏幕像素级定位（ball-animation 域锚点自动定位）。
 *
 * 背景：从托盘锚点飞出的球要对准托盘图标；但托盘图标位置无任何 API 可查
 * （Electron `tray.getBounds()` 仅 Win/macOS；SNI 协议不含位置；DDE 无公开查询），
 * 且图标顺序/增删/分辨率变化都会让写死的坐标漂移——唯一可靠路径 = **抓屏 + 像素模板匹配**。
 *
 * 算法（粗到细两级，纯计算无 electron 依赖，可离线测试）：
 * ① 灰阶化（0.299R + 0.587G + 0.114B，BT.601）；
 * ② 粗定位：图像与模板都按 `coarse` 倍率盒式降采样，在限定的 y 搜索带内全宽扫 NCC；
 * ③ 精定位：粗结果映射回原分辨率，在其邻域（`refineRadius`）内用原尺寸模板扫 NCC；
 * ④ 返回最优位置的**左上角坐标** + 置信分数（NCC ∈ [-1,1]；理想命中 ≈ 0.8+，阈值由调用方定）。
 */
export interface GrayImage {
  width: number
  height: number
  /** 行长 = width 的灰度值（0–255） */
  data: Float32Array
}

export interface MatchOptions {
  /** y 搜索带（灰阶图坐标，闭区间）——限定在 Dock 条等区域内，减少误配与计算量 */
  yMin: number
  yMax: number
  /** 粗定位降采样倍率（4 = 1/4 尺寸） */
  coarse: number
  /** 精定位邻域半径（原分辨率 px） */
  refineRadius: number
}

export interface MatchHit {
  /** 匹配区域左上角（灰阶图坐标） */
  x: number
  y: number
  /** NCC 置信分数 */
  score: number
}

/** RGB 图（3 字节/像素；颜色校验用——灰度 NCC 对"白/蓝圆图标 vs 白兔头"有误配，需颜色信息区分） */
export interface RgbImage {
  width: number
  height: number
  /** 行长 = width×3 的 RGB 值 */
  data: Uint8Array
}

/** RGBA/BGRA 位图 → RGB（通道顺序标志；nativeImage.toBitmap() 为 BGRA） */
export function bitmapToRgb(bitmap: Uint8Array, width: number, height: number, order: 'rgba' | 'bgra'): RgbImage {
  const data = new Uint8Array(width * height * 3)
  const rOff = order === 'rgba' ? 0 : 2
  const bOff = order === 'rgba' ? 2 : 0
  for (let i = 0, p = 0, q = 0; i < width * height; i++, p += 4, q += 3) {
    data[q] = bitmap[p + rOff]!
    data[q + 1] = bitmap[p + 1]!
    data[q + 2] = bitmap[p + bOff]!
  }
  return { width, height, data }
}

/** 中心加权（0.35~1.0，中心=1）：削弱四周背景像素对颜色校验的稀释（图标本体在中心） */
function centerWeights(w: number, h: number): Float32Array {
  const ws = new Float32Array(w * h)
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const sigma = Math.max(w, h) * 0.45
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / sigma
      const dy = (y - cy) / sigma
      ws[y * w + x] = 0.35 + 0.65 * Math.exp(-(dx * dx + dy * dy))
    }
  }
  return ws
}

/**
 * 颜色相似度（0~1）：模板与目标区域在 (x0,y0) 处的**中心加权归一化 RGB 距离**的补。
 * 1 = 色彩完全一致；用于在灰度 NCC 的多个候选里挑出颜色真正匹配的那个。
 */
export function colorScore(
  img: RgbImage,
  tpl: RgbImage,
  x0: number,
  y0: number,
  weights: Float32Array
): number {
  let sum = 0
  let wSum = 0
  for (let ty = 0; ty < tpl.height; ty++) {
    const row = (y0 + ty) * img.width + x0
    const trow = ty * tpl.width
    for (let tx = 0; tx < tpl.width; tx++) {
      const w = weights[ty * tpl.width + tx]!
      const i = (row + tx) * 3
      const t = (trow + tx) * 3
      const d =
        Math.abs(img.data[i]! - tpl.data[t]!) +
        Math.abs(img.data[i + 1]! - tpl.data[t + 1]!) +
        Math.abs(img.data[i + 2]! - tpl.data[t + 2]!)
      sum += (w * d) / 765
      wSum += w
    }
  }
  return 1 - (wSum > 0 ? sum / wSum : 1)
}

/** 模板的中心权重（与模板同尺寸；调用方缓存复用） */
export function templateWeights(tpl: RgbImage): Float32Array {
  return centerWeights(tpl.width, tpl.height)
}

/** RGBA/BGRA 位图 → 灰阶（调用方给通道顺序标志；nativeImage.toBitmap() 为 BGRA） */
export function bitmapToGray(bitmap: Uint8Array, width: number, height: number, order: 'rgba' | 'bgra'): GrayImage {
  const data = new Float32Array(width * height)
  const rOff = order === 'rgba' ? 0 : 2
  const bOff = order === 'rgba' ? 2 : 0
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = 0.299 * bitmap[p + rOff]! + 0.587 * bitmap[p + 1]! + 0.114 * bitmap[p + bOff]!
  }
  return { width, height, data }
}

/** 盒式降采样（factor 倍；宽高向下取整） */
function downsample(img: GrayImage, factor: number): GrayImage {
  const w = Math.max(1, Math.floor(img.width / factor))
  const h = Math.max(1, Math.floor(img.height / factor))
  const data = new Float32Array(w * h)
  const inv = 1 / (factor * factor)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * img.width + x * factor
        for (let dx = 0; dx < factor; dx++) sum += img.data[row + dx]!
      }
      data[y * w + x] = sum * inv
    }
  }
  return { width: w, height: h, data }
}

/** 模板的统计量（NCC 预计算用） */
interface TplStats {
  mean: number
  std: number
  n: number
}

function tplStats(tpl: GrayImage): TplStats {
  const n = tpl.width * tpl.height
  let sum = 0
  let sum2 = 0
  for (let i = 0; i < n; i++) {
    const v = tpl.data[i]!
    sum += v
    sum2 += v * v
  }
  const mean = sum / n
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), n }
}

/** 在 (x0, y0) 处算 NCC 分数（-1 表示图像局部方差过小=平坦区，视为无效位置） */
function nccAt(img: GrayImage, tpl: GrayImage, x0: number, y0: number, t: TplStats): number {
  let sum = 0
  let sum2 = 0
  let cross = 0
  for (let ty = 0; ty < tpl.height; ty++) {
    const row = (y0 + ty) * img.width + x0
    const trow = ty * tpl.width
    for (let tx = 0; tx < tpl.width; tx++) {
      const v = img.data[row + tx]!
      sum += v
      sum2 += v * v
      cross += v * tpl.data[trow + tx]!
    }
  }
  const mean = sum / t.n
  const varI = sum2 / t.n - mean * mean
  if (varI <= 1e-6) return -1
  const cov = cross / t.n - mean * t.mean
  return cov / (Math.sqrt(varI) * t.std)
}

/** 在 [xMin,xMax]×[yMin,yMax] 区域内扫描最优 NCC（返回左上角 + 分数） */
function scan(
  img: GrayImage,
  tpl: GrayImage,
  t: TplStats,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number
): MatchHit | null {
  const maxX = Math.min(xMax, img.width - tpl.width)
  const maxY = Math.min(yMax, img.height - tpl.height)
  let best: MatchHit | null = null
  for (let y = Math.max(0, yMin); y <= maxY; y++) {
    for (let x = Math.max(0, xMin); x <= maxX; x++) {
      const s = nccAt(img, tpl, x, y, t)
      if (!best || s > best.score) best = { x, y, score: s }
    }
  }
  return best
}

/**
 * 粗到细模板匹配。
 * @returns 最优命中（左上角坐标 + 分数）；模板比搜索区还大时返回 null
 */
export function matchTemplate(image: GrayImage, template: GrayImage, opts: MatchOptions): MatchHit | null {
  if (template.width > image.width || template.height > image.height) return null

  // ---- ② 粗定位（1/coarse 分辨率，全宽 × 限定 y 带） ----
  const f = Math.max(1, Math.round(opts.coarse))
  const imgC = downsample(image, f)
  const tplC = downsample(template, f)
  const tC = tplStats(tplC)
  if (tC.std <= 1e-6) return null
  const coarseHit = scan(
    imgC,
    tplC,
    tC,
    0,
    imgC.width - tplC.width,
    Math.floor(opts.yMin / f) - 1,
    Math.ceil(opts.yMax / f) + 1
  )
  if (!coarseHit) return null

  // ---- ③ 精定位（原分辨率，粗结果邻域内） ----
  const cx = coarseHit.x * f
  const cy = coarseHit.y * f
  const r = opts.refineRadius
  const t = tplStats(template)
  if (t.std <= 1e-6) return null
  const hit = scan(image, template, t, cx - r, cx + r, cy - r, cy + r)
  return hit ?? coarseHit
}

/**
 * 多候选匹配（粗到细 + 非极大值抑制）：返回分数最高的前 topN 个**互不重叠**的命中，
 * 供调用方（anchor.ts）再做颜色校验精选——灰度 NCC 单独用会有误配
 * （实测：白/蓝圆的浏览器图标与白兔头灰度结构相似，NCC 0.78 误配）。
 */
export function matchTemplateCandidates(
  image: GrayImage,
  template: GrayImage,
  opts: MatchOptions,
  topN: number
): MatchHit[] {
  if (template.width > image.width || template.height > image.height) return []
  const f = Math.max(1, Math.round(opts.coarse))
  const imgC = downsample(image, f)
  const tplC = downsample(template, f)
  const tC = tplStats(tplC)
  if (tC.std <= 1e-6) return []

  // 粗阶段：收集全部分数（粗分辨率），降序 + NMS（间距 = 模板宽/2，映射到粗分辨率）
  const xMin = 0
  const xMax = Math.max(0, imgC.width - tplC.width)
  const yMin = Math.max(0, Math.floor(opts.yMin / f) - 1)
  const yMax = Math.min(imgC.height - tplC.height, Math.ceil(opts.yMax / f) + 1)
  const coarse: MatchHit[] = []
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const s = nccAt(imgC, tplC, x, y, tC)
      if (s > -1) coarse.push({ x, y, score: s })
    }
  }
  coarse.sort((a, b) => b.score - a.score)
  const minDistC = Math.max(2, Math.floor((tplC.width * f) / 2 / f))
  const picked: MatchHit[] = []
  for (const c of coarse) {
    if (picked.length >= topN) break
    if (picked.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= minDistC)) picked.push(c)
  }

  // 精阶段：每个候选在粗位置邻域内做原分辨率精定位
  const t = tplStats(template)
  if (t.std <= 1e-6) return []
  const hits: MatchHit[] = []
  for (const c of picked) {
    const cx = c.x * f
    const cy = c.y * f
    const r = opts.refineRadius + f
    const hit = scan(image, template, t, cx - r, cx + r, cy - r, cy + r)
    if (hit) hits.push(hit)
  }
  hits.sort((a, b) => b.score - a.score)
  return hits
}
