import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildProjectDownloadTool } from '../src/main/agent/download/project-download-tool'

test('main download tool keeps output in the project and writes a verified file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-project-download-'))
  try {
    let fetches = 0
    const tool = buildProjectDownloadTool(root, root, {
      transport: {
        async fetch(url) {
          fetches += 1
          if (url.hostname === 'example.org') {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://cdn.example.org/data.txt' }
            })
          }
          assert.equal(url.hostname, 'cdn.example.org')
          return new Response('project data')
        }
      }
    })
    const outside = await tool.execute(
      'outside',
      { url: 'https://example.org/data.txt', outputPath: '../outside.txt' },
      undefined,
      {} as never
    )
    assert.equal(outside.isError, true)
    assert.equal(fetches, 0)

    const inside = await tool.execute(
      'inside',
      { url: 'https://example.org/data.txt', outputPath: 'downloads/data.txt' },
      undefined,
      {} as never
    )
    assert.equal(inside.isError, undefined)
    assert.equal(fetches, 2)
    assert.equal(await readFile(join(root, 'downloads/data.txt'), 'utf8'), 'project data')
    assert.match(String(inside.content[0]?.text), /sha256:[0-9a-f]{64}/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('main download tool rejects a redirect to a private host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-project-download-'))
  try {
    let fetches = 0
    const tool = buildProjectDownloadTool(root, root, {
      transport: {
        async fetch() {
          fetches += 1
          return new Response(null, {
            status: 302,
            headers: { location: 'https://127.0.0.1/private' }
          })
        }
      }
    })
    const result = await tool.execute(
      'private-redirect',
      { url: 'https://example.org/data.txt' },
      undefined,
      {} as never
    )
    assert.equal(result.isError, true)
    assert.equal(fetches, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
