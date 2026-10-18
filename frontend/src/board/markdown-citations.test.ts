/**
 * Markdown 引用角标链接——离线自测（纯字符串处理，不依赖 DOM）。
 *
 * 运行方式：cd frontend && npm run test:markdown-citations
 */
import {
  extractCitationSources,
  linkCitationMarkers,
  renderMarkdownWithCitations
} from './markdown'

let pass = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? `（${detail}）` : ''}`)
    console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

const samples = [
  '[1] 《新闻直播间》 20261018 09:00 — https://tv.cctv.com/a.shtml',
  '- [2] 中国新闻 — https://example.com/b?x=1',
  '[3] 标题 — [原文](https://example.com/c)',
  '[4] 无链接的来源'
].join('\n')

const sources = extractCitationSources(samples)
check('解析来源编号 → URL', sources.get(1) === 'https://tv.cctv.com/a.shtml')
check('允许前置列表符号', sources.get(2) === 'https://example.com/b?x=1')
check('支持 Markdown 链接里的 URL', sources.get(3) === 'https://example.com/c')
check('没有 URL 的条目不收录', !sources.has(4))

// 模型也常用 Markdown 有序列表写来源（2026-10-18 真机截图）
const ordered = [
  '1. 《新闻直播间》 20261018 09:00 — https://tv.cctv.com/a.shtml',
  '2) 《中国新闻》 20261018 19:00 — https://tv.cctv.com/b.shtml',
  '3、新华网 — https://example.com/c'
].join('\n')
const orderedSources = extractCitationSources(ordered)
check('有序列表 1. → URL', orderedSources.get(1) === 'https://tv.cctv.com/a.shtml')
check('有序列表 2) → URL', orderedSources.get(2) === 'https://tv.cctv.com/b.shtml')
check('有序列表 3、→ URL', orderedSources.get(3) === 'https://example.com/c')
check(
  '正文 [1] 能链到有序列表来源',
  linkCitationMarkers('新闻 [1] 与 [2]', orderedSources).includes(
    '[[1]](https://tv.cctv.com/a.shtml)'
  )
)

const linked = linkCitationMarkers('今天有新闻 [1]，还有 [2][3]，未知 [9]。', sources)
check(
  '正文 [n] 转成 Markdown 链接',
  linked.includes('[[1]](https://tv.cctv.com/a.shtml)') &&
    linked.includes('[[2]](https://example.com/b?x=1)') &&
    linked.includes('[[3]](https://example.com/c)')
)
check('找不到来源的标记保持原样', linked.includes('[9]') && !linked.includes('[[9]]'))

const fenced = ['```', 'const a = "[1]"', '```', '正文 [1]'].join('\n')
const fencedLinked = linkCitationMarkers(fenced, sources)
check(
  'fenced code 内的 [n] 不处理',
  fencedLinked.includes('const a = "[1]"') && fencedLinked.includes('正文 [[1]]')
)

const inline = '代码 `arr[1]` 与正文 [1]'
const inlineLinked = linkCitationMarkers(inline, sources)
check(
  '行内 code 内的 [n] 不处理',
  inlineLinked.includes('`arr[1]`') && inlineLinked.includes('正文 [[1]]')
)

const existing = '[[1]](https://old.example.com)'
check('已有链接不重复包裹', linkCitationMarkers(existing, sources) === existing)

const html = renderMarkdownWithCitations(
  '今天有新闻 [1]\n\n来源：\n[1] 新闻 — https://example.com/a'
)
check(
  '渲染结果包含可点击引用链接',
  html.includes('href="https://example.com/a"') && html.includes('[1]</a>'),
  html.slice(0, 160)
)

check(
  '没有来源列表时退化为普通 Markdown',
  !renderMarkdownWithCitations('普通 [1] 文本').includes('<a')
)

console.log(`\n=== markdown citations 离线测试：${pass} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  failures.forEach((f) => console.error(`  ✗ ${f}`))
  process.exit(1)
}
