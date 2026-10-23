/**
 * coding/steps 离线自测：
 *   npm run test:coding
 *
 * 覆盖：消息/思考合流、工具调用更新、计划、上限裁剪、总结。
 */
import assert from 'node:assert/strict'
import { CodingStepStore, contentText, normalizeToolStatus } from './steps'

function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (err) {
    console.error(`FAIL - ${name}`)
    throw err
  }
}

function main(): void {
  check('contentText 只取 text 块', () => {
    assert.equal(contentText({ type: 'text', text: 'hi' }), 'hi')
    assert.equal(contentText({ type: 'image' }), '')
    assert.equal(contentText(null), '')
  })

  check('工具状态归一化', () => {
    assert.equal(normalizeToolStatus('completed'), 'done')
    assert.equal(normalizeToolStatus('failed'), 'failed')
    assert.equal(normalizeToolStatus('in_progress'), 'running')
    assert.equal(normalizeToolStatus(undefined), 'running')
  })

  check('消息 chunk 合并成一条步骤', () => {
    let time = 1
    const store = new CodingStepStore({ now: () => time++ })
    store.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你' } })
    store.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } })
    const steps = store.list()
    assert.equal(steps.length, 1)
    assert.equal(steps[0].kind, 'message')
    assert.equal(steps[0].detail, '你好')
    assert.equal(steps[0].status, 'running')
  })

  check('思考后在回复时自动收起思考', () => {
    const store = new CodingStepStore()
    store.apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想' } })
    store.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '说' } })
    const [thought, message] = store.list()
    assert.equal(thought.kind, 'thought')
    assert.equal(thought.status, 'done')
    assert.equal(message.kind, 'message')
  })

  check('tool_call 与 tool_call_update 按 id 更新', () => {
    const store = new CodingStepStore()
    store.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: '写文件',
      kind: 'edit',
      status: 'in_progress',
      rawInput: { path: 'a.ts' }
    })
    let steps = store.list()
    assert.equal(steps.length, 1)
    assert.equal(steps[0].title, '写文件')
    assert.equal(steps[0].status, 'running')
    assert.match(steps[0].detail ?? '', /a\.ts/)

    store.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed'
    })
    steps = store.list()
    assert.equal(steps.length, 1)
    assert.equal(steps[0].status, 'done')
  })

  check('plan 转成一条计划步骤', () => {
    const store = new CodingStepStore()
    store.apply({
      sessionUpdate: 'plan',
      entries: [
        { content: '读代码', status: 'completed' },
        { content: '改代码', status: 'pending' }
      ]
    })
    const [step] = store.list()
    assert.equal(step.kind, 'plan')
    assert.match(step.detail ?? '', /读代码（已完成）/)
    assert.match(step.detail ?? '', /改代码/)
  })

  check('步骤超上限丢最旧', () => {
    const store = new CodingStepStore({ maxSteps: 3 })
    for (let index = 0; index < 5; index += 1) store.addSystem(`步骤 ${index}`)
    const steps = store.list()
    assert.equal(steps.length, 3)
    assert.equal(steps[0].title, '步骤 2')
    assert.equal(steps[2].title, '步骤 4')
  })

  check('summary 返回最后一条消息全文', () => {
    const store = new CodingStepStore()
    store.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第一段' } })
    store.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: '跑测试',
      status: 'completed'
    })
    store.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成了' } })
    assert.equal(store.summary(), '完成了')
  })

  check('sealStreams 收起进行中的文本步骤', () => {
    const store = new CodingStepStore()
    store.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } })
    store.sealStreams()
    assert.equal(store.list()[0].status, 'done')
  })

  check('超长文本按上限裁剪', () => {
    const store = new CodingStepStore({ maxText: 5 })
    store.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '1234567890' } })
    assert.equal(store.list()[0].detail, '12345…')
  })

  console.log('steps: all passed')
}

main()
