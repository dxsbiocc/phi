import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readRuntimeSessionMessagesText } from '../src/main/agent/runtime/runtime-session-text'

test('readRuntimeSessionMessagesText includes later JSONL user messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-runtime-session-text-'))
  try {
    const file = join(dir, 'session.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', id: 'session-1' }),
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: '用jupyter开始数据分析' }] }
        }),
        JSON.stringify({
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5000) }] }
        }),
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: '如何绘制一张散点图' }] }
        })
      ].join('\n')
    )

    const text = await readRuntimeSessionMessagesText(file)

    assert.match(text, /用jupyter开始数据分析/)
    assert.match(text, /如何绘制一张散点图/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
