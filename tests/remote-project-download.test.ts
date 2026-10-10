import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildRemoteProjectDownloadTool } from '../src/main/agent/download/remote-project-download-tool'

test('remote download delegates to the server backend and never writes the local anchor', async () => {
  const anchor = mkdtempSync(join(tmpdir(), 'phi-remote-download-anchor-'))
  const sentinel = join(anchor, 'sentinel.txt')
  writeFileSync(sentinel, 'untouched')
  const requests: unknown[] = []
  try {
    const tool = buildRemoteProjectDownloadTool(async (request) => {
      requests.push(request)
      return {
        path: 'ssh://cluster-a/project/downloads/data.txt',
        displayPath: 'downloads/data.txt',
        bytes: 12
      }
    })
    const result = await tool.execute(
      'call-1',
      {
        url: 'https://example.org/data.txt',
        outputPath: 'downloads/data.txt',
        maxFileBytes: 1024
      },
      undefined,
      {} as never,
      new AbortController().signal
    )

    assert.equal(result.isError, undefined)
    assert.deepEqual(requests, [
      {
        toolCallId: 'call-1',
        url: 'https://example.org/data.txt',
        outputPath: 'downloads/data.txt',
        maxFileBytes: 1024
      }
    ])
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched')
  } finally {
    rmSync(anchor, { recursive: true, force: true })
  }
})

test('remote download rejects unsafe paths and URLs before calling the backend', async () => {
  let calls = 0
  const tool = buildRemoteProjectDownloadTool(async () => {
    calls += 1
    throw new Error('must not run')
  })
  for (const params of [
    { url: 'http://example.org/data.txt' },
    { url: 'https://127.0.0.1/data.txt' },
    { url: 'https://example.org/data.txt', outputPath: '../outside.txt' },
    { url: 'https://example.org/data.txt', outputPath: '/tmp/outside.txt' }
  ]) {
    const result = await tool.execute('call', params, undefined, {} as never)
    assert.equal(result.isError, true)
  }
  assert.equal(calls, 0)
})

test('remote download reports server network failures without local fallback', async () => {
  const tool = buildRemoteProjectDownloadTool(async () => {
    throw new Error('服务器无法联网或无法访问该地址；请检查服务器网络/代理后重试。')
  })
  const result = await tool.execute(
    'call',
    { url: 'https://example.org/data.txt' },
    undefined,
    {} as never
  )
  assert.equal(result.isError, true)
  const content = result.content[0]
  assert.equal(content?.type, 'text')
  if (content?.type === 'text') assert.match(content.text, /服务器无法联网/)
})
