/**
 * pi-agent-core 接入层（2026-10-23）。
 *
 * 这里只做三件事：建模型、建 Agent、把 Key 显式传给每次调用。
 * 主循环、工具调度、参数校验、审批闸门全部由 pi-agent-core 提供。
 */
import {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool
} from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { buildAgentSystemPrompt } from './prompt'
import type { ExecutionMode } from './types'

/** 任务模式支持的思考强度（与 DeepSeek 模型的 thinkingLevelMap 对齐） */
export type TaskThinkingLevel = 'low' | 'high' | 'max'
const THINKING_LEVELS: TaskThinkingLevel[] = ['low', 'high', 'max']

/** 配置值归一化：未知值回退 high */
export function normalizeThinkingLevel(value: unknown): TaskThinkingLevel {
  return value === 'low' || value === 'max' ? value : 'high'
}

/**
 * 当前模型支持的思考强度（用于顶部切换菜单）。
 *
 * DeepSeek 各模型的 thinkingLevelMap 不同：deepseek-flash 支持 low/high/max，
 * deepseek-v4-pro 只支持 high/max。未知模型按模板（官方首个模型）取。
 */
export function thinkingLevelsForModel(modelId: string): TaskThinkingLevel[] {
  const known = deepseekProvider().getModels()
  const wanted = (modelId || '').trim()
  const template = known.find((item) => item.id === wanted) ?? known[0]
  const map = template?.thinkingLevelMap as Record<string, string | null> | undefined
  if (!map) return [...THINKING_LEVELS]
  return THINKING_LEVELS.filter((level) => map[level] != null)
}

export interface AgentBuildOptions {
  apiKey: string
  /** 聊天设置里的端点；空 = 用 DeepSeek 官方 */
  baseUrl: string
  /** 聊天设置里的模型名 */
  model: string
  /** 执行模式（决定系统提示词里的权限说明） */
  mode: ExecutionMode
  /** 思考强度（任务模式；缺省 high） */
  thinkingLevel?: TaskThinkingLevel
  tools: AgentTool[]
  beforeToolCall: NonNullable<AgentOptions['beforeToolCall']>
  /**
   * 重启后恢复的历史消息（transcript.ts 读回）。
   *
   * 不能放进 initialState.messages：那样构造函数会把历史开头的 system 当提示词，
   * 反而不再注入当天的系统提示与最新工具声明。这里先按最新配置建 Agent，
   * 再把历史追加到新 system 消息之后。
   */
  history?: AgentMessage[]
}

export interface BuiltAgent {
  agent: Agent
  /** 实际使用的模型 id（面板展示用） */
  modelId: string
  /** 模型上下文窗口（token；未知为 0） */
  contextWindow: number
}

/**
 * 用聊天已配置的 Key/端点/模型建一个 Agent。
 *
 * 走 DeepSeek 的 OpenAI 兼容协议：自定义端点只替换 baseUrl，协议保持一致；
 * Key 通过 streamFn 每次显式传入，不写进程环境变量（避免泄漏给子进程）。
 */
export function buildAgent(options: AgentBuildOptions): BuiltAgent {
  const provider = deepseekProvider()
  const known = provider.getModels()
  const wanted = (options.model || '').trim()

  // 以官方模型定义为模板（上下文窗口 / 兼容位），只替换 id 与 baseUrl
  const template = known.find((item) => item.id === wanted) ?? known[0]
  if (!template) throw new Error('pi-ai 没有可用的 DeepSeek 模型定义')

  const model = {
    ...template,
    id: wanted || template.id,
    baseUrl: (options.baseUrl || '').trim() || template.baseUrl
  }

  const models = createModels()
  models.setProvider(provider)

  const agent = new Agent({
    initialState: {
      systemPrompt: buildAgentSystemPrompt(new Date(), options.mode),
      model,
      tools: options.tools,
      // 开启推理：模型会返回 reasoning_content，面板里的「思考过程」才有内容（2026-10-24）
      thinkingLevel: options.thinkingLevel ?? 'high'
    },
    streamFn: (ctxModel, context, streamOptions) =>
      models.streamSimple(ctxModel, context, { ...(streamOptions ?? {}), apiKey: options.apiKey }),
    beforeToolCall: options.beforeToolCall
  })

  if (options.history && options.history.length > 0) {
    agent.state.messages = [...agent.state.messages, ...options.history]
  }

  return { agent, modelId: model.id, contextWindow: model.contextWindow ?? 0 }
}

export type { AgentTool }
