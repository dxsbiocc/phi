import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSessionTitlePrompt,
  normalizeSessionTitle,
  SessionTitleGenerator,
  type SessionTitleRequest
} from '../src/main/agent/session/session-title-generation'

const input = {
  sessionPath: 'session-a',
  userMessage: '帮我分析单细胞数据，比较不同数据集的质控参数',
  assistantMessage: '可以根据原始计数和归一化表达矩阵分别设置参数。'
}

test('title prompt bounds source material and requires a concise title-only response', () => {
  const prompt = buildSessionTitlePrompt({
    userMessage: '用'.repeat(4000),
    assistantMessage: '答'.repeat(2000)
  })
  const source = JSON.parse(prompt.split('\n').at(-1)!)
  assert.equal(source.user.length, 3000)
  assert.equal(source.assistant.length, 1500)
  assert.match(prompt, /8–16 Chinese characters or 3–6 English words/)
  assert.match(prompt, /source material only/)
  assert.match(prompt, /Return only the title/)
})

test('title normalization handles Chinese and English title wrappers', () => {
  const cases = new Map([
    ['标题：单细胞数据质控', '单细胞数据质控'],
    ['Title: "Compare Dataset Quality"', 'Compare Dataset Quality'],
    ['“单细胞数据质控”', '单细胞数据质控'],
    ['# **单细胞数据质控**', '单细胞数据质控'],
    ['<title>单细胞数据质控</title>', '单细胞数据质控'],
    ['```json\n{"title":"单细胞数据质控"}\n```', '单细胞数据质控'],
    ['<think>I should choose the topic.</think>\n单细胞数据质控', '单细胞数据质控'],
    ['<analysis>Hidden reasoning</analysis>Dataset Quality Checks.', 'Dataset Quality Checks']
  ])
  for (const [response, expected] of cases) {
    assert.equal(normalizeSessionTitle(response), expected, response)
  }
})

test('title cap uses Unicode codepoints and keeps ordinary short titles intact', () => {
  const chinese = '这是一个很长的单细胞分析数据集质量控制参数比较以及调试工作标题'
  assert.equal(normalizeSessionTitle(chinese), Array.from(chinese).slice(0, 32).join(''))
  assert.equal(
    normalizeSessionTitle('A very long English conversation title for scientific analysis')?.length,
    32
  )
  const astral = '𠀀'.repeat(40)
  assert.equal(Array.from(normalizeSessionTitle(astral)!).length, 32)
  assert.equal(normalizeSessionTitle('Dataset Quality Checks'), 'Dataset Quality Checks')
})

test('title normalization rejects malformed, thinking-only, tool and error responses', () => {
  for (const response of [
    '',
    '   ',
    '<think>only reasoning</think>',
    '<think>unclosed reasoning',
    'unclosed reasoning</think>',
    '<|analysis|>reasoning',
    '{"title":12}',
    '{"message":"no title"}',
    '{"title":',
    '"Unclosed title',
    'Unclosed title”',
    'Title one\nTitle two',
    '```python\nprint("hello")\n```',
    'with exit code 1 and',
    'tool_result: done',
    'Error: provider request failed',
    '抱歉，无法生成标题',
    'Here is the title for this conversation',
    "I'll read the notebook first",
    '我会先查看项目结构',
    'print("hello")',
    'import pandas as pd',
    '---',
    'x'.repeat(8193)
  ]) {
    assert.equal(normalizeSessionTitle(response), null, response.slice(0, 80))
  }
})

test('concurrent requests dedupe by session while separate sessions run independently', async () => {
  const requests: SessionTitleRequest[] = []
  const resolvers: Array<(text: string) => void> = []
  const generator = new SessionTitleGenerator({
    request: (request) => {
      requests.push(request)
      return new Promise((resolve) => resolvers.push(resolve))
    }
  })
  const first = generator.generate(input)
  const duplicate = generator.generate({ ...input, userMessage: 'later message' })
  const secondSession = generator.generate({ ...input, sessionPath: 'session-b' })
  assert.equal(first, duplicate)
  await Promise.resolve()
  assert.equal(requests.length, 2)
  resolvers[0]('单细胞质控参数比较')
  resolvers[1]('另一个会话标题')
  assert.equal(await first, '单细胞质控参数比较')
  assert.equal(await secondSession, '另一个会话标题')
  generator.dispose()
})

test('failed and invalid requests can retry without leaving a pending entry', async () => {
  let calls = 0
  const generator = new SessionTitleGenerator({
    request: async () => {
      calls++
      if (calls === 1) throw new Error('provider unavailable')
      return calls === 2 ? '<think>no title</think>' : '质控参数比较'
    }
  })
  assert.equal(await generator.generate(input), null)
  assert.equal(await generator.generate(input), null)
  assert.equal(await generator.generate(input), '质控参数比较')
  assert.equal(calls, 3)
  generator.dispose()
})

test('timeout aborts the request and resolves even when the provider ignores cancellation', async () => {
  let signal: AbortSignal | undefined
  const generator = new SessionTitleGenerator({
    timeoutMs: 15,
    request: async (request) => {
      signal = request.signal
      return new Promise(() => {})
    }
  })
  assert.equal(await generator.generate(input), null)
  assert.equal(signal?.aborted, true)
  generator.dispose()
})

test('cancel allows a new request while late output from the cancelled request is ignored', async () => {
  let lateResult: ((text: string) => void) | undefined
  let calls = 0
  const generator = new SessionTitleGenerator({
    request: async () => {
      calls++
      if (calls === 1) return new Promise((resolve) => (lateResult = resolve))
      return '新的标题'
    }
  })
  const cancelled = generator.generate(input)
  await Promise.resolve()
  generator.cancel(input.sessionPath)
  const replacement = generator.generate(input)
  lateResult?.('过期的标题')
  assert.equal(await cancelled, null)
  assert.equal(await replacement, '新的标题')
  generator.dispose()
})

test('dispose aborts every pending request and prevents future requests', async () => {
  const signals: AbortSignal[] = []
  const generator = new SessionTitleGenerator({
    request: async ({ signal }) => {
      signals.push(signal)
      return new Promise(() => {})
    }
  })
  const first = generator.generate(input)
  const second = generator.generate({ ...input, sessionPath: 'session-b' })
  await Promise.resolve()
  generator.dispose()
  assert.equal(await first, null)
  assert.equal(await second, null)
  assert.equal(signals.length, 2)
  assert.ok(signals.every((signal) => signal.aborted))
  assert.equal(await generator.generate(input), null)
  assert.equal(signals.length, 2)
})

test('empty source and disposal before dispatch do not contact the provider', async () => {
  let calls = 0
  const generator = new SessionTitleGenerator({
    request: async () => {
      calls++
      return 'Dataset Quality Checks'
    }
  })
  assert.equal(await generator.generate({ ...input, userMessage: '  ' }), null)
  const pending = generator.generate(input)
  generator.dispose()
  assert.equal(await pending, null)
  assert.equal(calls, 0)
})
