/**
 * LLM 服务商预设（settings 域 model 层，首启引导 §7.6.5 步 2 的数据源）。
 *
 * 每个预设给常用 base_url + 模型；keyUrl = 申请 Key 的官网（null = 不显示「去获取 Key」，
 * 如本地部署 / 自定义）。「本地部署」模型留空，用 modelPlaceholder 提示手填。
 * 选择器是"推断式受控"：不做独立 state，按当前 base_url 反推选中项（见 matchProviderId）——
 * 用户手改地址后自然落到「自定义」，选预设则直接覆盖地址与模型（用户选定）。
 */

export interface LlmProviderPreset {
  id: string
  label: string
  /** 选中后自动填入的 API 地址（'' = 不填，留给用户手输） */
  baseUrl: string
  /** 选中后自动填入的模型（'' = 留空） */
  model: string
  /** 「去获取 Key」跳转的官网（null = 不显示该入口） */
  keyUrl: string | null
  /** 模型输入框的占位提示（当前预设生效时） */
  modelPlaceholder?: string
}

export const LLM_PROVIDER_PRESETS: ReadonlyArray<LlmProviderPreset> = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'qwen',
    label: '阿里通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com'
  },
  {
    id: 'kimi',
    label: 'Kimi 月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-latest',
    keyUrl: 'https://platform.moonshot.cn'
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn'
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    keyUrl: 'https://cloud.siliconflow.cn'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'local',
    label: '本地部署（OpenAI 兼容）',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    // 本地部署无需申请 Key（选中时隐藏「去获取 Key」）
    keyUrl: null,
    modelPlaceholder: '填你本地服务的模型名'
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    model: '',
    keyUrl: null
  }
]

/**
 * 按当前 base_url 反推选中的服务商：
 * - '' → null（未选，视图显示"选择服务商…"占位项）；
 * - 命中预设 base_url → 预设 id；否则 → 'custom'（用户手填了别的地址）。
 */
export function matchProviderId(baseUrl: string): string | null {
  const url = baseUrl.trim()
  if (!url) return null
  const hit = LLM_PROVIDER_PRESETS.find((p) => p.baseUrl !== '' && p.baseUrl === url)
  return hit ? hit.id : 'custom'
}

/** 按 id 取预设（视图里 keyUrl / modelPlaceholder 用） */
export function findProvider(id: string | null): LlmProviderPreset | undefined {
  if (!id) return undefined
  return LLM_PROVIDER_PRESETS.find((p) => p.id === id)
}
