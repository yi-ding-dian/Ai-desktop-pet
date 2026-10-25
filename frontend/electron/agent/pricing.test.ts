/** 任务费用估算离线自测：npm run test:agent-pricing */
import assert from 'node:assert/strict'
import { estimateCost, isPeakTime, priceForModel } from './pricing'

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

// 2026-10-26 是周一；2026-10-31 是周六
const MON_0059 = Date.UTC(2026, 9, 26, 0, 59)
const MON_0100 = Date.UTC(2026, 9, 26, 1, 0)
const MON_0359 = Date.UTC(2026, 9, 26, 3, 59)
const MON_0400 = Date.UTC(2026, 9, 26, 4, 0)
const MON_0559 = Date.UTC(2026, 9, 26, 5, 59)
const MON_0600 = Date.UTC(2026, 9, 26, 6, 0)
const MON_0959 = Date.UTC(2026, 9, 26, 9, 59)
const MON_1000 = Date.UTC(2026, 9, 26, 10, 0)
const SAT_0200 = Date.UTC(2026, 9, 31, 2, 0)

function main(): void {
  check('峰谷：UTC 01:00–04:00 / 06:00–10:00 的工作日', () => {
    assert.equal(isPeakTime(MON_0059), false)
    assert.equal(isPeakTime(MON_0100), true)
    assert.equal(isPeakTime(MON_0359), true)
    assert.equal(isPeakTime(MON_0400), false)
    assert.equal(isPeakTime(MON_0559), false)
    assert.equal(isPeakTime(MON_0600), true)
    assert.equal(isPeakTime(MON_0959), true)
    assert.equal(isPeakTime(MON_1000), false)
  })

  check('峰谷：周末全天低谷', () => {
    assert.equal(isPeakTime(SAT_0200), false)
  })

  check('Flash 高峰价：未命中 ¥2 / 命中 ¥0.04 / 输出 ¥8 每百万', () => {
    const price = priceForModel('deepseek-flash')
    assert.ok(price)
    const cost = estimateCost(price, { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }, MON_0100)
    assert.equal(cost.peak, true)
    assert.equal(cost.input, 2)
    assert.equal(cost.cacheRead, 0.04)
    assert.equal(cost.output, 8)
    assert.equal(cost.total, 10.04)
  })

  check('Flash 低谷价：高峰价的一半', () => {
    const price = priceForModel('deepseek-flash')
    assert.ok(price)
    const cost = estimateCost(price, { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }, SAT_0200)
    assert.equal(cost.peak, false)
    assert.equal(cost.total, 5.02)
  })

  check('Pro 高峰价', () => {
    const price = priceForModel('deepseek-v4-pro')
    assert.ok(price)
    const cost = estimateCost(price, { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }, MON_0600)
    assert.equal(cost.input, 9)
    assert.equal(cost.cacheRead, 0.3)
    assert.equal(cost.output, 27)
  })

  check('旧模型名按 Flash 档计费；未知模型不估算', () => {
    assert.deepEqual(priceForModel('deepseek-chat'), priceForModel('deepseek-flash'))
    assert.deepEqual(priceForModel('DeepSeek-Flash'), priceForModel('deepseek-flash'))
    assert.equal(priceForModel('my-custom-model'), null)
    assert.equal(priceForModel(''), null)
  })

  check('零用量：费用为 0，仍返回峰谷标记', () => {
    const price = priceForModel('deepseek-flash')
    assert.ok(price)
    const cost = estimateCost(price, {}, MON_0100)
    assert.equal(cost.total, 0)
    assert.equal(cost.peak, true)
  })

  console.log('pricing.test 全部通过')
}

main()
