/**
 * 工作窗消息导航几何——离线自测（纯函数，不依赖 Electron/DOM）。
 *
 * 运行方式：cd frontend && npm run test:work-navigator
 */
import {
  NAVIGATOR_TICK_HEIGHT,
  activeTickId,
  layoutTicks,
  type NavigatorAnchor
} from './navigator'

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

const anchors: NavigatorAnchor[] = [
  { id: 'q1', offsetTop: 0, height: 80 },
  { id: 'q2', offsetTop: 500, height: 80 },
  { id: 'q3', offsetTop: 1000, height: 80 }
]

const ticks = layoutTicks(anchors, 1000, 400)
check('刻度数量与锚点一致', ticks.length === 3)
check('首个刻度在顶部留边', ticks[0].top >= NAVIGATOR_TICK_HEIGHT / 2)
check('最后一个刻度在底部留边', ticks[2].top <= 400 - NAVIGATOR_TICK_HEIGHT / 2)
check('位置单调递增', ticks[0].top < ticks[1].top && ticks[1].top < ticks[2].top)
check('比例按内容偏移计算', Math.abs(ticks[1].ratio - 0.5) < 1e-6, `ratio=${ticks[1].ratio}`)

const empty = layoutTicks(anchors, 0, 400)
check('内容高度未知时全部贴顶', empty.every((tick) => tick.ratio === 0))

const overflow = layoutTicks([{ id: 'x', offsetTop: 5000, height: 10 }], 1000, 400)
check('越界偏移夹到 1', overflow[0].ratio === 1)
check('越界偏移不超出导航轨', overflow[0].top <= 400)

// 内容 1000、视口 400 → 可滚动 600；q2 的比例 0.5 → scrollTop 300 处高亮
check('顶部 → 选中首条', activeTickId(ticks, 0, 1000, 400) === 'q1')
check('滚到第二条 → 选中 q2', activeTickId(ticks, 300, 1000, 400) === 'q2')
check('滚到底部 → 选中最后一条', activeTickId(ticks, 600, 1000, 400) === 'q3')
check('内容不足一屏 → 选中首条', activeTickId(ticks, 0, 300, 400) === 'q1')
check('无刻度 → null', activeTickId([], 0, 1000, 400) === null)

console.log(`\n=== work navigator 离线测试：${pass} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  failures.forEach((f) => console.error(`  ✗ ${f}`))
  process.exit(1)
}
