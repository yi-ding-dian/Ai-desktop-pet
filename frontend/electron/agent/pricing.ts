/**
 * 任务费用估算（2026-10-25）。
 *
 * DeepSeek **没有查询单价的接口**：/models 只列模型，/user/balance 只给账户余额；
 * 官方价目表只能本地维护。这里按官方人民币价目估算，单位：元 / 百万 token（高峰价）。
 *
 * 计费规则（官方，2026-09-10 起）：
 *  - 高峰 = 北京时间周一至周五 09:00–12:00、14:00–18:00（= UTC 01:00–04:00、06:00–10:00）；
 *  - 其余时段、周末按高峰价的 50%；
 *  - 中国法定节假日按低谷价，但调休上班的周末仍按周末低谷价。这里没有节假日日历，
 *    节假日会按工作日算成高峰（略微高估，不会少算）。
 *
 * 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（2026-10 核对）
 */

export interface TokenPrice {
  /** 未命中输入（元 / 百万 token，高峰价） */
  input: number
  /** 缓存命中输入（元 / 百万 token，高峰价） */
  cacheRead: number
  /** 输出（元 / 百万 token，高峰价） */
  output: number
}

export interface CostEstimate {
  input: number
  cacheRead: number
  output: number
  total: number
  /** 本次请求是否处于高峰时段 */
  peak: boolean
}

const FLASH: TokenPrice = { input: 2, cacheRead: 0.04, output: 8 }
const PRO: TokenPrice = { input: 9, cacheRead: 0.3, output: 27 }

/**
 * 模型 id → 高峰期单价。
 *
 * 旧名（deepseek-v4-flash / deepseek-chat / deepseek-reasoner）官方仍接受并
 * 按 Flash 档计费；未知模型返回 null（不估算，避免拿别的模型价格硬套）。
 */
const MODEL_PRICES: Record<string, TokenPrice> = {
  'deepseek-flash': FLASH,
  'deepseek-v4-flash': FLASH,
  'deepseek-v4-flash-vision-exp': FLASH,
  'deepseek-chat': FLASH,
  'deepseek-reasoner': FLASH,
  'deepseek-v4-pro': PRO
}

export function priceForModel(modelId: string): TokenPrice | null {
  return MODEL_PRICES[(modelId || '').trim().toLowerCase()] ?? null
}

/**
 * 是否高峰时段（按 UTC 判断，避免依赖运行机器的本地时区）。
 *
 * 只按周一至周五判断：调休上班的周末官方仍按低谷价，所以这里不特殊处理。
 */
export function isPeakTime(at: number): boolean {
  const date = new Date(at)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600)
}

/**
 * 估算一次模型调用的费用（人民币元）。
 *
 * @param at 请求开始时间（毫秒时间戳）；缺失时按当前时间判断峰谷
 */
export function estimateCost(
  price: TokenPrice,
  usage: { input?: number; cacheRead?: number; output?: number },
  at: number = Date.now()
): CostEstimate {
  const peak = isPeakTime(at)
  const factor = (peak ? 1 : 0.5) / 1_000_000
  const input = Math.max(0, usage.input ?? 0) * price.input * factor
  const cacheRead = Math.max(0, usage.cacheRead ?? 0) * price.cacheRead * factor
  const output = Math.max(0, usage.output ?? 0) * price.output * factor
  return { input, cacheRead, output, total: input + cacheRead + output, peak }
}
