/**
 * 「文件」分区（settings 域 panels 层）：文件分析限额 + 上下文预算。
 *
 * 两个阈值都遵循"先本地估算、超了不硬塞"：
 * - 文件字数上限：本轮**所有附件合计**超过即拒绝整轮，不调用模型；
 * - 上下文预算：历史+记忆+文件+问题超过时先丢历史（提示用户），仍超才拒绝。
 * 后端 FileConfig / LlmConfig 是最终校验方；这里只做输入与保存前提示。
 */
import type { ReactElement } from 'react'
import Section from '../components/section'
import { Field, SwitchRow, TextField } from '../components/fields'
import type { PanelProps } from './panel-props'

interface FilePanelProps extends PanelProps {
  fileMaxCharsError: string | null
  contextTokensError: string | null
}

export default function FilePanel({
  form,
  setField,
  fileMaxCharsError,
  contextTokensError
}: FilePanelProps): ReactElement {
  return (
    <Section
      title="文件"
      desc="本地读取文本 / 代码文件与图片；只把提取出的正文/图片发给模型，正文不写入聊天历史。中文约 1 字 ≈ 1 token，每张图片约 2,000 tokens，两个上限要一起看。"
    >
      <Field
        label="单轮文件字数上限"
        hint="本轮所有文本附件合计（默认 20,000，范围 1,000–100,000）。超过直接拒绝，不调用模型；图片不占字数，另受大小限制。"
        error={fileMaxCharsError}
      >
        <TextField
          type="number"
          min={1_000}
          max={100_000}
          step={1_000}
          value={form.fileMaxChars}
          onValueChange={(value) => setField('fileMaxChars', value)}
        />
      </Field>

      <Field
        label="上下文预算（tokens）"
        hint="历史 + 记忆 + 文件/图片 + 问题的合计预算（默认 100,000）。超了先丢历史并提示；仍超则拒绝。不要超过所用模型的上下文窗口。"
        error={contextTokensError}
      >
        <TextField
          type="number"
          min={8_000}
          max={200_000}
          step={1_000}
          value={form.contextTokens}
          onValueChange={(value) => setField('contextTokens', value)}
        />
      </Field>

      <SwitchRow
        label="允许发送图片"
        hint="需要模型支持多模态（视觉）。关闭后图片会在本地被拒绝，不会发 API 请求。图片与文件共用单轮 3 个附件上限，单张默认 8MB。"
        checked={form.allowImages}
        onCheckedChange={(checked) => setField('allowImages', checked)}
      />
    </Section>
  )
}
