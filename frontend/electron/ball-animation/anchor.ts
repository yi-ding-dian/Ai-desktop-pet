/**
 * 托盘锚点定位（ball-animation 域）：**抓屏 + 模板匹配**自动找出托盘兔头图标的屏幕坐标。
 *
 * 为什么需要：球必须从"兔头图标"腾起/收回，但图标位置无 API 可查（Electron `tray.getBounds()`
 * 仅 Win/macOS；SNI 协议不含位置；DDE 无公开查询），且图标顺序/增删/分辨率变化会让写死的
 * 坐标漂移——因此每次动画开始前抓一次主屏，用模板匹配现场定位；失败则回退兜底配置
 * （TRAY_ANCHOR / PET_TRAY_ANCHOR），**任何失败都不影响动画播放**。
 *
 * 匹配策略（两级判别，实测调参于 1920×1080 Deepin/X11）：
 * ① 灰度 NCC 粗到细取 **top-N 候选**（NMS 去重）——纯灰度会有误配（实测：Dock 上白/蓝圆的
 *    浏览器图标与白兔头灰度结构相似，NCC 0.78 误配）；
 * ② **中心加权 RGB 颜色校验**精选（兔头的白毛/绿眼/粉腮色彩独特）——综合分 = NCC × 颜色分，
 *    阈值判定；命中区域中心 = 图标中心（模板绕图标中心裁制）。
 *
 * 抓屏路径（Linux/X11 实测：desktopCapturer 可用，见 docs/reports/frontend/2026-10-15-ball-animation.md）：优先 `desktopCapturer`
 * （原生、无子进程），异常/空图时回退 `ffmpeg -f x11grab` 子进程抓图（环境自带 ffmpeg，不新增依赖）。
 *
 * 模板：`resources/tray-anchor-template.png`（从实测截图裁出的 24×24 真实渲染兔头，中心 = 图标中心），
 * 打包经 electron-builder extraResources 落 `process.resourcesPath/tray-anchor-template.png`；
 * 备用模板 = 托盘图标素材（build/icon.png 开发态 / resourcesPath/tray-icon.png 生产态）缩到 24×24。
 * **模板维护**：托盘图标外观更新后主模板会失配（自动定位回退到备用模板/兜底坐标）——
 * 重新裁制方法：全屏截图 → 裁托盘区 → 定位图标像素中心 → 以中心裁 24×24 → 覆盖本文件对应素材。
 */
import { app, desktopCapturer, nativeImage, screen } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { TRAY_ANCHOR } from './config'
import {
  bitmapToGray,
  bitmapToRgb,
  colorScore,
  matchTemplateCandidates,
  templateWeights,
  type GrayImage,
  type RgbImage
} from './template-match'

const execFileAsync = promisify(execFile)

/** 定位结果 */
export interface AnchorResult {
  x: number
  y: number
  /** auto = 模板匹配命中；fallback = 用兜底配置值 */
  source: 'auto' | 'fallback'
  /** 综合置信（NCC × 颜色分；fallback 时 -1） */
  score: number
}

/** 主模板综合命中阈值（NCC × 颜色分；实测命中 ~0.85+，误配 ~0.65-，取 0.75 分界） */
const TEMPLATE_MIN_SCORE = 0.75
/** 备用模板（托盘图标素材）阈值（渲染差异大，放低） */
const FALLBACK_TEMPLATE_MIN_SCORE = 0.6
/** 搜索带：从屏底往上 90px（Dock 条）；位置合理性：x 距屏幕左右边缘至少 40px */
const DOCK_BAND_PX = 90
const EDGE_MARGIN_PX = 40
/** 粗定位降采样倍率 / 精定位邻域半径 / 颜色校验候选数 */
const COARSE_FACTOR = 4
const REFINE_RADIUS = 8
const CANDIDATE_TOPN = 6
/** 模板边长（与素材一致；匹配前统一缩放到该尺寸） */
const TEMPLATE_SIZE = 24

/** 抓屏/模板图组（灰阶 + RGB，来自同一位图） */
interface ImagePair {
  gray: GrayImage
  rgb: RgbImage
}

/** nativeImage → 灰阶+RGB（尺寸防御同 imageToGray；无效图返回 null） */
function imageToPairs(img: Electron.NativeImage, expectW?: number, expectH?: number): ImagePair | null {
  if (img.isEmpty()) return null
  const size = img.getSize()
  if (size.width < 8 || size.height < 8) return null
  // DPR 防御：位图尺寸与预期（逻辑尺寸）不符时缩放到预期，保证与模板的匹配尺度一致
  let target = img
  if (expectW && expectH && (size.width !== expectW || size.height !== expectH)) {
    target = img.resize({ width: expectW, height: expectH, quality: 'better' })
  }
  const ts = target.getSize()
  const bitmap = target.toBitmap()
  return {
    gray: bitmapToGray(bitmap, ts.width, ts.height, 'bgra'),
    rgb: bitmapToRgb(bitmap, ts.width, ts.height, 'bgra')
  }
}

/** 主模板路径（dev = 源码 resources/；生产 = extraResources 落位） */
function resolveTemplatePath(): string | null {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'tray-anchor-template.png')
    : join(app.getAppPath(), 'resources', 'tray-anchor-template.png')
  return existsSync(path) ? path : null
}

/** 备用模板路径（托盘图标素材，与 tray/index.ts 同一份素材来源） */
function resolveIconPath(): string | null {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'tray-icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(path) ? path : null
}

/** 调试：非空时把抓屏图保存到该路径（自检模式用，便于对比排查误配/未命中） */
let debugCaptureSavePath: string | null = null

/** 抓主屏（优先 desktopCapturer；失败回退 ffmpeg x11grab） */
async function capturePrimaryScreen(): Promise<ImagePair | null> {
  const display = screen.getPrimaryDisplay()
  const w = display.size.width
  const h = display.size.height

  // ---- 路径 1：desktopCapturer（原生） ----
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h }
    })
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (src) {
      if (debugCaptureSavePath && !src.thumbnail.isEmpty()) {
        try {
          writeFileSync(debugCaptureSavePath, src.thumbnail.toPNG())
        } catch (err) {
          console.warn('[ball-animation] 抓屏图保存失败：', err)
        }
      }
      const pair = imageToPairs(src.thumbnail, w, h)
      if (pair) return pair
      console.warn('[ball-animation] desktopCapturer 返回空图，改用 ffmpeg 抓屏')
    } else {
      console.warn('[ball-animation] desktopCapturer 无屏幕源，改用 ffmpeg 抓屏')
    }
  } catch (err) {
    console.warn('[ball-animation] desktopCapturer 抓屏异常，改用 ffmpeg 抓屏：', err)
  }

  // ---- 路径 2：ffmpeg -f x11grab 子进程（环境自带；抓主屏区域到临时 png 再读入） ----
  try {
    const out = join(app.getPath('temp'), 'pet-anchor-shot.png')
    await execFileAsync(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error',
        '-f', 'x11grab',
        '-video_size', `${w}x${h}`,
        '-i', `:0.0+${display.bounds.x},${display.bounds.y}`,
        '-frames:v', '1',
        out
      ],
      { timeout: 2000 }
    )
    return imageToPairs(nativeImage.createFromPath(out), w, h)
  } catch (err) {
    console.warn('[ball-animation] ffmpeg 抓屏失败：', err)
    return null
  }
}

/** 候选详情（debug 用） */
interface CandidateDebug {
  x: number
  y: number
  ncc: number
  color: number
  combined: number
}

/**
 * 用给定模板在抓屏图上找图标中心（灰度 NCC top-N → 颜色校验精选 → 边缘合理性校验）。
 * @returns 命中（中心坐标 + 综合分）或 null
 */
function locateWithTemplate(
  shot: ImagePair,
  tplPath: string,
  minScore: number,
  verbose: boolean
): { x: number; y: number; score: number } | null {
  const raw = nativeImage.createFromPath(tplPath)
  if (raw.isEmpty()) return null
  const tpl = imageToPairs(raw.resize({ width: TEMPLATE_SIZE, height: TEMPLATE_SIZE, quality: 'better' }), TEMPLATE_SIZE, TEMPLATE_SIZE)
  if (!tpl) return null

  const hits = matchTemplateCandidates(shot.gray, tpl.gray, {
    yMin: Math.max(0, shot.gray.height - DOCK_BAND_PX),
    yMax: shot.gray.height,
    coarse: COARSE_FACTOR,
    refineRadius: REFINE_RADIUS
  }, CANDIDATE_TOPN)

  const weights = templateWeights(tpl.rgb)
  const debugRows: CandidateDebug[] = []
  let best: CandidateDebug | null = null
  for (const h of hits) {
    const cs = h.score > 0 ? colorScore(shot.rgb, tpl.rgb, h.x, h.y, weights) : 0
    const combined = h.score * cs
    const row: CandidateDebug = {
      x: Math.round(h.x + TEMPLATE_SIZE / 2),
      y: Math.round(h.y + TEMPLATE_SIZE / 2),
      ncc: h.score,
      color: cs,
      combined
    }
    debugRows.push(row)
    if (best === null || combined > best.combined) best = row
  }
  if (verbose) {
    for (const r of debugRows) {
      console.log(
        `[ball-animation/自检] 候选 (${r.x},${r.y}) ncc=${r.ncc.toFixed(3)} 颜色=${r.color.toFixed(3)} 综合=${r.combined.toFixed(3)}`
      )
    }
  }
  if (!best || best.combined < minScore) return null
  // 位置合理性：x 不贴屏幕左右边缘（排除误配到面板两端的装饰元素）
  if (best.x < EDGE_MARGIN_PX || best.x > shot.gray.width - EDGE_MARGIN_PX) return null
  return { x: best.x, y: best.y, score: best.combined }
}

/**
 * 定位托盘锚点（每次动画开始时调用；目标 <300ms，单次不重试）。
 * 命中 → 图标中心（screen 坐标）；任何失败 → 兜底配置 TRAY_ANCHOR。
 */
export async function locateTrayAnchor(): Promise<AnchorResult> {
  const t0 = Date.now()
  const fallback: AnchorResult = { x: TRAY_ANCHOR.x, y: TRAY_ANCHOR.y, source: 'fallback', score: -1 }
  try {
    const shot = await capturePrimaryScreen()
    if (!shot) {
      console.warn(`[ball-animation] 锚点定位：抓屏失败，用兜底 (${fallback.x},${fallback.y})`)
      return fallback
    }
    // 主模板：实测截图裁出的真实渲染兔头
    const tplPath = resolveTemplatePath()
    if (tplPath) {
      const hit = locateWithTemplate(shot, tplPath, TEMPLATE_MIN_SCORE, false)
      if (hit) {
        console.log(
          `[ball-animation] 锚点定位：自动命中 (${hit.x},${hit.y}) 置信 ${hit.score.toFixed(3)}（耗时 ${Date.now() - t0}ms）`
        )
        return { x: hit.x, y: hit.y, source: 'auto', score: hit.score }
      }
    } else {
      console.warn('[ball-animation] 锚点定位：主模板文件缺失（resources/tray-anchor-template.png）')
    }
    // 备用模板：托盘图标素材（主模板失配时试）
    const iconPath = resolveIconPath()
    if (iconPath) {
      const hit = locateWithTemplate(shot, iconPath, FALLBACK_TEMPLATE_MIN_SCORE, false)
      if (hit) {
        console.log(
          `[ball-animation] 锚点定位：自动命中（备用模板）(${hit.x},${hit.y}) 置信 ${hit.score.toFixed(3)}（耗时 ${Date.now() - t0}ms）`
        )
        return { x: hit.x, y: hit.y, source: 'auto', score: hit.score }
      }
    }
    console.warn(`[ball-animation] 锚点定位：模板未命中，用兜底 (${fallback.x},${fallback.y})（耗时 ${Date.now() - t0}ms）`)
    return fallback
  } catch (err) {
    console.warn(`[ball-animation] 锚点定位异常，用兜底 (${fallback.x},${fallback.y})：`, err)
    return fallback
  }
}

/**
 * 锚点定位自检（dev/排障用；由环境变量触发，不影响正常流程）：
 *  - `PET_ANCHOR_SELFTEST=1`：抓主屏跑一次定位并打印结果；
 *  - `PET_ANCHOR_SELFTEST=/path/shot.png`：对指定截图跑匹配（离线单测，打印全部候选详情）。
 */
export async function runAnchorSelfTest(arg: string): Promise<void> {
  const t0 = Date.now()
  if (arg !== '1') {
    // 文件模式：对给定截图跑匹配（输出全部候选，便于调参/排查）
    const pair = imageToPairs(nativeImage.createFromPath(arg))
    if (!pair) {
      console.warn(`[ball-animation/自检] 截图读取失败：${arg}`)
      return
    }
    const tplPath = resolveTemplatePath()
    const hit = tplPath ? locateWithTemplate(pair, tplPath, TEMPLATE_MIN_SCORE, true) : null
    console.log(
      `[ball-animation/自检] 文件模式 ${arg}（${pair.gray.width}x${pair.gray.height}）→ ` +
        (hit ? `命中 (${hit.x},${hit.y}) 综合置信 ${hit.score.toFixed(3)}` : '未命中（全部候选如上）') +
        `（耗时 ${Date.now() - t0}ms）`
    )
    return
  }
  // 抓屏模式（同时保存抓屏图/候选详情，便于对比排查）
  debugCaptureSavePath = join(app.getPath('temp'), 'pet-anchor-capture.png')
  const res = await locateTrayAnchor()
  debugCaptureSavePath = null
  console.log(`[ball-animation/自检] 抓屏图已保存：${join(app.getPath('temp'), 'pet-anchor-capture.png')}`)
  console.log(
    `[ball-animation/自检] 抓屏模式 → ${res.source === 'auto' ? `自动命中 (${res.x},${res.y}) 置信 ${res.score.toFixed(3)}` : `兜底 (${res.x},${res.y})`}`
  )
}
