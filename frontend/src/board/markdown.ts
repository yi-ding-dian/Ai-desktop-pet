/**
 * 黑板 Markdown 渲染（讲解卡用）：markdown-it + highlight.js。
 *
 * 设计要点（对齐设计文档 §7.5.5 步 2"Markdown/代码高亮"，2026-10-15 用户验收改为渐进渲染）：
 *  - **流式渐进渲染**：token 阶段每次到达即整块重渲染（渲染源 = 当前 streamText），
 *    用户能看到标题/列表/代码块逐步成形，而不是等 reply_end（reply_end 要等 TTS 音频帧送完）；
 *  - **半围栏兜底**：流式中途/被截断（interrupted）的文本可能停在未闭合的 ``` 围栏内，
 *    renderMarkdownSafe 会临时补合，保证代码块立即成形且不吞后续内容（见 closeOpenFences）；
 *  - html 关闭（AI 输出不放行裸 HTML，防样式污染）；linkify 打开（裸 URL 可点）；
 *    换行按软换行渲染（breaks:true，教学场景讲究行内断句）；
 *  - 语言包按需注册（控制打包体积），未注册语言自动降级为纯文本代码块；
 *  - 深色主题 CSS 由调用侧引入（highlight.js/styles/github-dark.css + board.css 覆盖）。
 */
import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it'
import hljs from 'highlight.js/lib/core'

// 常用语言按需注册（教学场景高频：python/js/ts/json/bash 等；其余按纯文本渲染）
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdownLang from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('css', css)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('go', go)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdownLang)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

/** HTML 转义（与 markdown-it 内置 escapeHtml 同规则；此处独立定义，避免构造器内自引用造成类型循环） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const md: MarkdownItInstance = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight: (str, lang) => {
    // 返回以 <pre 开头的字符串 = 整个代码块的 HTML（markdown-it 不再包 pre/code）
    if (lang && hljs.getLanguage(lang)) {
      try {
        const inner = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
        return `<pre class="hljs code-block"><code class="language-${escapeHtml(lang)}">${inner}</code></pre>`
      } catch {
        /* 高亮失败 → 落到下面的纯文本分支 */
      }
    }
    return `<pre class="hljs code-block"><code>${escapeHtml(str)}</code></pre>`
  }
})

/**
 * 围栏补合（只作用于渲染源，不动 state/消息模型）：
 * 统计"行首 ``` "围栏（markdown-it 判定：行首最多 3 个空格缩进 + 三个反引号）出现次数，
 * 奇数 = 有未闭合围栏 → 尾部临时补 "\n```"，让流式中途的半截代码块能**立即渲染成代码块**
 * （而不是 "```python" 裸奔的纯文本），同时保证后续还未到达的内容不会被吞进代码块。
 * 已闭合文本是恒等变换（终态 fullText 即使被截断——interrupted——也由本函数兜底）。
 */
function closeOpenFences(text: string): string {
  let fences = 0
  for (const line of text.split('\n')) {
    if (/^ {0,3}```/.test(line)) fences++
  }
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text
}

/**
 * 把讲解文本渲染为 HTML（供 dangerouslySetInnerHTML；null/空串安全）。
 * 流式 token 中途与 reply_end 终态共用本函数（渐进渲染 + 半围栏兜底一个入口）。
 */
export function renderMarkdownSafe(text: string | null | undefined): string {
  return md.render(closeOpenFences(text ?? ''))
}

/**
 * 从「来源」列表提取引用编号 → URL（2026-10-18）。
 *
 * 模型输出来源的格式并不稳定，已见到：
 *   ``[1] 《新闻直播间》 … — https://…``
 *   ``1. 《新闻直播间》 … — https://…``
 *   ``1) …`` / ``1、…``（允许前置 ``-`` / ``*``）
 * 这里统一把「方括号编号」或「有序列表编号」映射到该行第一个 URL；正文里的
 * ``[n]`` 与来源的 ``n.`` 共用同一个编号。
 */
export function extractCitationSources(text: string): Map<number, string> {
  const sources = new Map<number, string>()
  for (const line of text.split('\n')) {
    const match = line.match(
      /^\s*(?:[-*]\s*)?(?:\[(\d+)\]|(\d+)[.)、）．])\s*[^\n]*?(https?:\/\/[^\s)>\]]+)/
    )
    if (!match) continue
    const number = Number(match[1] ?? match[2])
    // URL 尾部可能带句号/逗号/分号（模型手写结果），去掉
    const url = match[3].replace(/[.,;。，；]+$/, '')
    if (Number.isInteger(number) && number > 0 && !sources.has(number)) {
      sources.set(number, url)
    }
  }
  return sources
}

/**
 * 把正文里的 ``[n]`` 换成指向来源 URL 的 Markdown 链接。
 *
 * 跳过 fenced code / 行内 code；``(?<!\[)`` 避免把 ``[[1]](url)`` 这类已有链接
 * 再包一层。找不到对应来源时保持原样。
 */
export function linkCitationMarkers(
  text: string,
  sources: Map<number, string>
): string {
  if (sources.size === 0) return text
  let inFence = false
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      // 行内代码原样保留
      return line
        .split(/(`[^`]*`)/g)
        .map((part, index) => {
          if (index % 2 === 1) return part
          return part.replace(/(?<!\[)\[(\d+)\]/g, (whole, digits: string) => {
            const url = sources.get(Number(digits))
            return url ? `[${whole}](${url})` : whole
          })
        })
        .join('')
    })
    .join('\n')
}

/**
 * Markdown 渲染 + 引用角标可点击（工作窗/黑板共用）。
 * 没有来源列表时退化为普通渲染，行为不变。
 */
export function renderMarkdownWithCitations(
  text: string | null | undefined
): string {
  const raw = text ?? ''
  const sources = extractCitationSources(raw)
  return renderMarkdownSafe(
    sources.size > 0 ? linkCitationMarkers(raw, sources) : raw
  )
}
