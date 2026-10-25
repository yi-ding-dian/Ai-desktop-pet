/**
 * 设置表单模型（settings 域 form 层）：config 快照 ⇄ 表单值 ⇄ set_config patch。
 *
 * 职责边界（纯函数，无 React / 无 IO）：
 * - snapshotToForm：后端 `config` 事件（宽松 JSON）→ 表单值（字段缺失给安全默认，不崩）；
 * - buildPatch：只发出**有变化**的字段（设计文档 §7.6.2：patch 增量；key 空=不改）；
 * - hasChanges：dirty 判定（"未保存改动"提示与保存按钮禁用依据）。
 *
 * 字段对应 config.toml（§6.3 / backend/shared/config.py）：
 *   llm.base_url / llm.model（key 不在 toml：单独入 keyring，patch 里走 llm.api_key 专用字段）
 *   pet.name / voice.enabled / voice.voice / behavior.enabled / behavior.proactive_enabled /
 *   behavior.quiet_hours / memory.enabled
 * 读取一律宽松：后端返回 `llm.api_key` 掩码（或旧版 `api_key_masked`）都能回显。
 */
import type { ConfigData } from '../../shared/protocol'
import { formatQuietHours, parseQuietHours } from './quiet-hours'
import { isPetScale } from '../../shared/pet-scale'

/** 表单值（UI 双向绑定；字符串字段保持"用户输入原样"，比较/提交时再 trim） */
export interface FormValues {
  llmBaseUrl: string
  llmModel: string
  /** 新 API key 输入框（空 = 不修改；不预填掩码） */
  llmKeyInput: string
  /** 服务端给出的 key 掩码（只读展示，如 sk-****f3a9 / (未配置)） */
  llmKeyMasked: string
  petName: string
  /** 宠物缩放档位（'0.8'/'0.9'/'1.0'/'1.1'/'1.2'；下拉选择，见 PetPanel） */
  petScale: string
  /** 回复气泡自动收起时长（秒；字符串保存用户输入；0 = 不自动收起） */
  bubbleIdleSeconds: string
  voiceEnabled: boolean
  voiceName: string
  behaviorEnabled: boolean
  behaviorProactiveEnabled: boolean
  /** 免打扰时段文本（"23:00-07:00"，多条逗号分隔；空 = 关闭） */
  quietHoursText: string
  memoryEnabled: boolean
  /** 文件分析：单轮合计字数上限（字符串保存用户输入；保存时校验 1,000–100,000） */
  fileMaxChars: string
  /** 文件分析：上下文预算 tokens（字符串保存用户输入；保存时校验 8,000–200,000） */
  contextTokens: string
  /** 文件分析：是否允许发送图片（需多模态模型；关闭时后端本地拒绝图片） */
  allowImages: boolean
  /** 联网搜索（DeepSeek Search/Fetch；默认关闭，11-01 起按次计费） */
  searchEnabled: boolean
  /** DeepSeek 官方接口根地址（不是对话 base_url） */
  searchBaseUrl: string
  /** 每次搜索返回条数（字符串保存用户输入；保存时校验 1–50） */
  searchCount: string
  /** 任务模式默认工作区（空 = 平台默认；保存后由主进程经内部端点读取） */
  agentDefaultWorkspace: string
}

/** 空表单（等待 config 或字段缺失时的底座；布尔默认与 backend config.py 默认一致） */
export const EMPTY_FORM: FormValues = {
  llmBaseUrl: '',
  llmModel: '',
  llmKeyInput: '',
  llmKeyMasked: '',
  petName: '',
  petScale: '1.0',
  bubbleIdleSeconds: '30',
  voiceEnabled: true,
  voiceName: '',
  behaviorEnabled: true,
  behaviorProactiveEnabled: true,
  quietHoursText: '',
  memoryEnabled: true,
  fileMaxChars: '20000',
  contextTokens: '100000',
  allowImages: true,
  searchEnabled: true,
  searchBaseUrl: 'https://api.deepseek.com',
  searchCount: '5',
  agentDefaultWorkspace: ''
}

// ------------------------------------------------------------------ 宽松读取工具

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** quiet_hours 宽容取值：数组（后端主形态）/ 单字符串（手改 toml）都能回显 */
function asQuietHours(v: unknown): string | undefined {
  if (Array.isArray(v)) return formatQuietHours(v)
  if (typeof v === 'string') return v
  return undefined
}

/** 数字字段宽容取值：number（后端主形态）/ 数字字符串都能回显；其它返回 undefined。 */
function asNumberText(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v))
  if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}

/** 缩放档位宽容取值：数值/数字字符串且在白名单内才回显（否则用默认 1.0）。 */
function asScaleText(v: unknown): string | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return isPetScale(n) ? n.toFixed(1) : undefined
}

/** 严格解析非负整数（用户输入）：空串/小数/负号/科学计数法 → null。 */
export function parseIntegerText(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : null
}

/** 读 key 掩码：`llm.api_key`（约定）→ `llm.api_key_masked`（兼容）→ 顶层同名（兜底） */
function readKeyMask(config: ConfigData, llm: Record<string, unknown> | undefined): string {
  for (const candidate of [llm?.api_key, llm?.api_key_masked, config.llm_api_key]) {
    const s = asString(candidate)
    if (s && s.trim()) return s
  }
  return ''
}

// ------------------------------------------------------------------ 快照 → 表单

/** config 快照（后端 `config` 事件）→ 表单值 */
export function snapshotToForm(config: ConfigData): FormValues {
  const llm = asObject(config.llm)
  const pet = asObject(config.pet)
  const voice = asObject(config.voice)
  const behavior = asObject(config.behavior)
  const memory = asObject(config.memory)
  const files = asObject(config.files)
  const search = asObject(config.search)
  const agent = asObject(config.agent)

  return {
    llmBaseUrl: asString(llm?.base_url) ?? '',
    llmModel: asString(llm?.model) ?? '',
    llmKeyInput: '', // 永远不回填明文/掩码到输入框（掩码单独字段展示）
    llmKeyMasked: readKeyMask(config, llm),
    petName: asString(pet?.name) ?? '',
    petScale: asScaleText(pet?.scale) ?? '1.0',
    bubbleIdleSeconds: asNumberText(pet?.bubble_idle_seconds) ?? '30',
    voiceEnabled: asBool(voice?.enabled) ?? true,
    voiceName: asString(voice?.voice) ?? '',
    behaviorEnabled: asBool(behavior?.enabled) ?? true,
    behaviorProactiveEnabled: asBool(behavior?.proactive_enabled) ?? true,
    quietHoursText: asQuietHours(behavior?.quiet_hours) ?? '',
    memoryEnabled: asBool(memory?.enabled) ?? true,
    fileMaxChars: asNumberText(files?.max_chars) ?? '20000',
    contextTokens: asNumberText(llm?.context_tokens) ?? '100000',
    allowImages: asBool(files?.allow_images) ?? true,
    searchEnabled: asBool(search?.enabled) ?? true,
    searchBaseUrl: asString(search?.base_url) ?? 'https://api.deepseek.com',
    searchCount: asNumberText(search?.count) ?? '5',
    agentDefaultWorkspace: asString(agent?.default_workspace) ?? ''
  }
}

// ------------------------------------------------------------------ 表单 → patch

/**
 * 构建 set_config patch（设计文档 §7.6.2）：
 * - 只包含发生变化的字段（与基线比较，trim 后语义比较）；
 * - key：输入为空 = 不带该字段（不改）；有输入 → `llm.api_key`；
 * - quiet_hours：由调用方先经 parseQuietHours 校验，这里接收解析好的数组；
 * - 无任何变化 → 返回 null（调用方禁用保存）。
 */
export function buildPatch(
  form: FormValues,
  baseline: FormValues,
  quietHours: string[]
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}

  const llm: Record<string, unknown> = {}
  if (form.llmBaseUrl.trim() !== baseline.llmBaseUrl.trim()) llm.base_url = form.llmBaseUrl.trim()
  if (form.llmModel.trim() !== baseline.llmModel.trim()) llm.model = form.llmModel.trim()
  const newKey = form.llmKeyInput.trim()
  if (newKey) llm.api_key = newKey // key 专用字段：空 = 不修改
  if (Object.keys(llm).length > 0) patch.llm = llm

  const petPatch: Record<string, unknown> = {}
  if (form.petName.trim() !== baseline.petName.trim()) {
    petPatch.name = form.petName.trim()
  }
  const bubbleIdle = parseIntegerText(form.bubbleIdleSeconds)
  if (
    bubbleIdle !== null &&
    bubbleIdle !== parseIntegerText(baseline.bubbleIdleSeconds)
  ) {
    petPatch.bubble_idle_seconds = bubbleIdle
  }
  const petScale = Number(form.petScale)
  if (isPetScale(petScale) && Math.abs(petScale - Number(baseline.petScale)) > 1e-6) {
    petPatch.scale = petScale
  }
  if (Object.keys(petPatch).length > 0) patch.pet = petPatch

  const voice: Record<string, unknown> = {}
  if (form.voiceEnabled !== baseline.voiceEnabled) voice.enabled = form.voiceEnabled
  if (form.voiceName.trim() !== baseline.voiceName.trim()) voice.voice = form.voiceName.trim()
  if (Object.keys(voice).length > 0) patch.voice = voice

  const behavior: Record<string, unknown> = {}
  if (form.behaviorEnabled !== baseline.behaviorEnabled) behavior.enabled = form.behaviorEnabled
  if (form.behaviorProactiveEnabled !== baseline.behaviorProactiveEnabled) {
    behavior.proactive_enabled = form.behaviorProactiveEnabled
  }
  const baselineQuiet = parseQuietHours(baseline.quietHoursText)
  const baselineList = baselineQuiet.ok ? baselineQuiet.list : []
  if (quietHours.join('|') !== baselineList.join('|')) behavior.quiet_hours = quietHours
  if (Object.keys(behavior).length > 0) patch.behavior = behavior

  if (form.memoryEnabled !== baseline.memoryEnabled) {
    patch.memory = { enabled: form.memoryEnabled }
  }

  // 联网搜索：只提交有变化的字段；count 语法非法时不提交（save 入口会拦）
  const searchPatch: Record<string, unknown> = {}
  if (form.searchEnabled !== baseline.searchEnabled) {
    searchPatch.enabled = form.searchEnabled
  }
  if (form.searchBaseUrl.trim() !== baseline.searchBaseUrl.trim()) {
    searchPatch.base_url = form.searchBaseUrl.trim()
  }
  const searchCount = parseIntegerText(form.searchCount)
  if (
    searchCount !== null &&
    searchCount !== parseIntegerText(baseline.searchCount)
  ) {
    searchPatch.count = searchCount
  }
  if (Object.keys(searchPatch).length > 0) patch.search = searchPatch

  // 文件分析：只提交有变化且语法合法的整数；范围校验在保存入口
  // （useSettingsController.save 的 fileMaxCharsError/contextTokensError）完成。
  const filesPatch: Record<string, unknown> = {}
  const maxChars = parseIntegerText(form.fileMaxChars)
  if (maxChars !== null && maxChars !== parseIntegerText(baseline.fileMaxChars)) {
    filesPatch.max_chars = maxChars
  }
  if (form.allowImages !== baseline.allowImages) {
    filesPatch.allow_images = form.allowImages
  }
  if (Object.keys(filesPatch).length > 0) patch.files = filesPatch
  const contextTokens = parseIntegerText(form.contextTokens)
  if (contextTokens !== null && contextTokens !== parseIntegerText(baseline.contextTokens)) {
    llm.context_tokens = contextTokens
    patch.llm = llm
  }

  // 任务模式：只提交有变化的默认工作区（空串 = 平台默认；路径合法性由后端校验）
  const agentPatch: Record<string, unknown> = {}
  if (form.agentDefaultWorkspace.trim() !== baseline.agentDefaultWorkspace.trim()) {
    agentPatch.default_workspace = form.agentDefaultWorkspace.trim()
  }
  if (Object.keys(agentPatch).length > 0) patch.agent = agentPatch

  return Object.keys(patch).length > 0 ? patch : null
}

/** 是否有未保存改动（保存按钮可用性 / 离开提示依据）；免打扰时段非法输入也算"有改动"（保存时拦截提示） */
export function hasChanges(form: FormValues, baseline: FormValues): boolean {
  const quiet = parseQuietHours(form.quietHoursText)
  if (!quiet.ok) return true
  // 数字字段语法非法时也算"有改动"：否则保存按钮禁用，用户无法触发字段校验提示。
  if (parseIntegerText(form.fileMaxChars) === null) return true
  if (parseIntegerText(form.contextTokens) === null) return true
  if (parseIntegerText(form.bubbleIdleSeconds) === null) return true
  if (!isPetScale(Number(form.petScale))) return true
  if (parseIntegerText(form.searchCount) === null) return true
  return buildPatch(form, baseline, quiet.list) !== null
}
