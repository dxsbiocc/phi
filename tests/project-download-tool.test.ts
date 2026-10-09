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

test('remote project download refuses to write through the local anchor', async () => {
  const anchor = await mkdtemp(join(tmpdir(), 'phi-remote-download-anchor-'))
  try {
    let fetches = 0
    const tool = buildProjectDownloadTool(anchor, anchor, {
      remoteProject: true,
      transport: {
        async fetch() {
          fetches += 1
          return new Response('must stay remote')
        }
      }
    })
    const result = await tool.execute(
      'remote-download',
      { url: 'https://example.org/data.txt', outputPath: 'downloads/data.txt' },
      undefined,
      {} as never
    )

    assert.equal(result.isError, true)
    assert.match(String(result.content[0]?.text), /不会回退到本机项目锚点/)
    assert.equal(fetches, 0)
    await assert.rejects(readFile(join(anchor, 'downloads/data.txt')))
  } finally {
    await rm(anchor, { recursive: true, force: true })
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

test('main download tool refuses IPv4-mapped IPv6 private addresses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phi-project-download-'))
  try {
    let fetches = 0
    const tool = buildProjectDownloadTool(root, root, {
      transport: {
        async fetch() {
          fetches += 1
          return new Response('no')
        }
      }
    })
    for (const url of [
      'https://[::ffff:127.0.0.1]/data.txt',
      'https://[::ffff:10.0.0.1]/data.txt',
      'https://[::ffff:169.254.169.254]/latest'
    ]) {
      const result = await tool.execute('mapped', { url }, undefined, {} as never)
      assert.equal(result.isError, true, url)
    }
    assert.equal(fetches, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
