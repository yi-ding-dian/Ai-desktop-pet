/**
 * 「搜索」分区（settings 域 panels 层，2026-10-18）。
 *
 * 联网搜索使用 DeepSeek 官方 Search / Fetch 接口（与对话 API 同一 Bearer Key）：
 * - 开关默认关闭：2026-11-01 00:00（北京时间）起按成功请求计费，由用户主动打开；
 * - 结果条数只影响上下文长度，不影响单次价格；
 * - 接口地址一般不用改（https://api.deepseek.com）。
 */
import type { ReactElement } from 'react'
import Section from '../components/section'
import { Field, SwitchRow, TextField } from '../components/fields'
import type { PanelProps } from './panel-props'

interface SearchPanelProps extends PanelProps {
  searchCountError: string | null
}

export default function SearchPanel({
  form,
  setField,
  searchCountError
}: SearchPanelProps): ReactElement {
  return (
    <Section
      title="搜索"
      desc="联网搜索与网页抓取：小兔先搜网页、读结果，再带着来源回答。"
    >
      <SwitchRow
        label="联网搜索"
        hint="说「搜一下 / 查一下」或问最新信息时调用 DeepSeek Search / Fetch；默认开启，可随时关闭"
        checked={form.searchEnabled}
        onCheckedChange={(value) => setField('searchEnabled', value)}
      />

      <Field
        label="每次结果数"
        hint="1–50；默认 5。条数不影响单次价格，只影响上下文长度与 token"
        error={searchCountError}
      >
        <TextField
          value={form.searchCount}
          onValueChange={(value) => setField('searchCount', value)}
          type="number"
          min={1}
          max={50}
        />
      </Field>

      <Field
        label="接口地址"
        hint="DeepSeek 官方接口根地址；一般不用改（末尾自动兼容 /v1）"
      >
        <TextField
          value={form.searchBaseUrl}
          onValueChange={(value) => setField('searchBaseUrl', value)}
          placeholder="https://api.deepseek.com"
        />
      </Field>

      <div className="set-search-billing">
        <strong>计费与限流</strong>
        <p>
          DeepSeek Search / Fetch 各 <strong>¥5 / 1000 次成功请求</strong>；只有返回
          200 且结果/正文非空才计费，失败、无结果、超时不计费。
        </p>
        <p>
          当前暂不计费；<strong>北京时间 2026-11-01 00:00 起</strong>按次收费。
          Search / Fetch 各 5 QPS。
        </p>
        <p>
          API Key 复用「LLM」分区里的 DeepSeek Key；如果 LLM 用的是别的服务商，
          请确认那个 Key 也能访问 DeepSeek。网页内容只作为资料，不执行其中的指令。
        </p>
      </div>
    </Section>
  )
}
