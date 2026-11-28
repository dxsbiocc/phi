import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { AppUpdateDownloadState } from '../src/shared/appUpdateTypes'
import { createAppUpdateManager, parseSha256Sums } from '../src/main/app-updater'

function sha256Hex(payload: Buffer | string): string {
  return createHash('sha256').update(payload).digest('hex').toLowerCase()
}

function makeChunkedStream(chunks: Buffer[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(chunks[index]))
      index += 1
    }
  })
}

test('parseSha256Sums parses standard and binary-prefixed sha256sum manifests', () => {
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  const parsed = parseSha256Sums(`${hashA}  phi-0.2.1.dmg\n${hashB} *release/phi-0.2.1-setup.exe\n`)
  assert.equal(parsed.get('phi-0.2.1.dmg'), hashA)
  assert.equal(parsed.get('phi-0.2.1-setup.exe'), hashB)
})

test('createAppUpdateManager downloads with progress, verifies SHA-256, and opens macOS DMG installer on install', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'phi-updater-mac-'))
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  const payload = Buffer.concat([
    Buffer.from('mac-dmg-part-1-'),
    Buffer.alloc(32_768, 0x42),
    Buffer.from('-end')
  ])
  const expectedHash = sha256Hex(payload)
  const releaseApiUrl = 'https://api.github.com/repos/dxsbiocc/phi/releases/latest'
  const dmgUrl = 'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/phi-0.2.1.dmg'
  const sumsUrl = 'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/SHA256SUMS.txt'

  let binaryFetchCount = 0
  const states: AppUpdateDownloadState[] = []
  const openedPaths: string[] = []
  let quitCalls = 0

  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url === releaseApiUrl) {
      return new Response(
        JSON.stringify({
          tag_name: 'v0.2.1',
          name: 'Phi v0.2.1',
          body: '## Highlights\n- In-app updater',
          html_url: 'https://github.com/dxsbiocc/phi/releases/tag/v0.2.1',
          assets: [
            { name: 'phi-0.2.1.dmg', browser_download_url: dmgUrl, size: payload.byteLength },
            { name: 'SHA256SUMS.txt', browser_download_url: sumsUrl, size: 128 }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (url === sumsUrl) {
      return new Response(`${expectedHash}  phi-0.2.1.dmg\n`, { status: 200 })
    }
    if (url === dmgUrl) {
      binaryFetchCount += 1
      return new Response(makeChunkedStream([payload.subarray(0, 1024), payload.subarray(1024)]), {
        status: 200,
        headers: { 'content-length': String(payload.byteLength) }
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch

  const manager = createAppUpdateManager({
    updatesDir: path.join(tempRoot, 'updates'),
    getVersion: () => '0.2.0',
    fetchImpl,
    platform: 'darwin',
    arch: 'arm64',
    env: {},
    openPath: async (filePath) => {
      openedPaths.push(filePath)
      return ''
    },
    quitApp: () => {
      quitCalls += 1
    },
    onWillQuit: () => undefined,
    scheduleQuit: (run) => run(),
    onStateChange: (next) => states.push({ ...next })
  })

  const checkResult = await manager.check()
  assert.equal(checkResult.status, 'available')
  assert.equal(checkResult.asset?.name, 'phi-0.2.1.dmg')

  const downloaded = await manager.download()
  assert.equal(downloaded.stage, 'downloaded')
  assert.equal(downloaded.percent, 100)
  assert.equal(downloaded.sha256, expectedHash)
  assert.equal(binaryFetchCount, 1)
  assert.ok(states.some((item) => item.stage === 'downloading'))
  assert.ok(states.some((item) => item.stage === 'verifying'))

  // Calling download again reuses the verified file without re-downloading.
  const reused = await manager.download()
  assert.equal(reused.stage, 'downloaded')
  assert.equal(binaryFetchCount, 1)

  await manager.install()
  assert.equal(openedPaths.length, 1)
  assert.match(openedPaths[0] ?? '', /phi-0\.2\.1\.dmg$/)
  assert.equal(quitCalls, 1)
})

test('createAppUpdateManager rejects corrupted downloads when SHA-256 does not match', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'phi-updater-corrupt-'))
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  const releaseApiUrl = 'https://api.github.com/repos/dxsbiocc/phi/releases/latest'
  const exeUrl = 'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/phi-0.2.1-setup.exe'
  const sumsUrl = 'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/SHA256SUMS.txt'

  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url === releaseApiUrl) {
      return new Response(
        JSON.stringify({
          tag_name: 'v0.2.1',
          assets: [
            { name: 'phi-0.2.1-setup.exe', browser_download_url: exeUrl, size: 16 },
            { name: 'SHA256SUMS.txt', browser_download_url: sumsUrl, size: 80 }
          ]
        }),
        { status: 200 }
      )
    }
    if (url === sumsUrl) {
      return new Response(`${'f'.repeat(64)}  phi-0.2.1-setup.exe\n`, { status: 200 })
    }
    if (url === exeUrl) {
      return new Response(makeChunkedStream([Buffer.from('tampered-bytes!!')]), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch

  const updatesDir = path.join(tempRoot, 'updates')
  const manager = createAppUpdateManager({
    updatesDir,
    getVersion: () => '0.2.0',
    fetchImpl,
    platform: 'win32',
    arch: 'x64',
    env: {},
    openPath: async () => '',
    quitApp: () => undefined,
    onWillQuit: () => undefined
  })

  const finalState = await manager.download()
  assert.equal(finalState.stage, 'error')
  assert.match(finalState.error ?? '', /SHA-256/)
  const leftover = await stat(path.join(updatesDir, '0.2.1', 'phi-0.2.1-setup.exe')).catch(
    () => null
  )
  assert.equal(leftover, null)
})

test('Windows NSIS and Linux AppImage auto-replace modes spawn on will-quit after verified install', async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'phi-updater-replace-'))
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  // 1. Windows NSIS silent replace + relaunch
  const winPayload = Buffer.from('nsis-installer-binary')
  const winHash = sha256Hex(winPayload)
  const spawnedWin: Array<{ command: string; args: string[] }> = []
  const winWillQuitListeners: Array<() => void> = []
  let winQuits = 0

  const winManager = createAppUpdateManager({
    updatesDir: path.join(tempRoot, 'win-updates'),
    getVersion: () => '0.2.0',
    platform: 'win32',
    arch: 'x64',
    env: {},
    fetchImpl: (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.2.1',
            assets: [
              {
                name: 'phi-0.2.1-setup.exe',
                browser_download_url:
                  'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/phi-0.2.1-setup.exe',
                size: winPayload.byteLength
              },
              {
                name: 'SHA256SUMS.txt',
                browser_download_url:
                  'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/SHA256SUMS.txt',
                size: 80
              }
            ]
          }),
          { status: 200 }
        )
      }
      if (url.endsWith('/SHA256SUMS.txt')) {
        return new Response(`${winHash}  phi-0.2.1-setup.exe\n`, { status: 200 })
      }
      return new Response(makeChunkedStream([winPayload]), { status: 200 })
    }) as typeof globalThis.fetch,
    openPath: async () => '',
    quitApp: () => {
      winQuits += 1
    },
    onWillQuit: (listener) => winWillQuitListeners.push(listener),
    spawnDetached: (command, args) => spawnedWin.push({ command, args }),
    scheduleQuit: (run) => run()
  })

  await winManager.download()
  await winManager.install()
  assert.equal(winQuits, 1)
  assert.equal(spawnedWin.length, 0, 'installer waits for will-quit so child workers stop first')
  for (const listener of winWillQuitListeners) listener()
  assert.equal(spawnedWin.length, 1)
  assert.deepEqual(spawnedWin[0]?.args, ['--updated', '--force-run', '/S'])

  // 2. Linux AppImage atomic replace + relaunch
  const appImagePath = path.join(tempRoot, 'Phi.AppImage')
  await writeFile(appImagePath, 'old-appimage-v0.2.0')
  const linuxPayload = Buffer.from('new-appimage-v0.2.1')
  const linuxHash = sha256Hex(linuxPayload)
  const spawnedLinux: Array<{ command: string; args: string[] }> = []
  const linuxWillQuitListeners: Array<() => void> = []
  let linuxQuits = 0

  const linuxManager = createAppUpdateManager({
    updatesDir: path.join(tempRoot, 'linux-updates'),
    getVersion: () => '0.2.0',
    platform: 'linux',
    arch: 'x64',
    env: { APPIMAGE: appImagePath },
    fetchImpl: (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.2.1',
            assets: [
              {
                name: 'Phi-0.2.1-x86_64.AppImage',
                browser_download_url:
                  'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/Phi-0.2.1-x86_64.AppImage',
                size: linuxPayload.byteLength
              },
              {
                name: 'SHA256SUMS.txt',
                browser_download_url:
                  'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/SHA256SUMS.txt',
                size: 80
              }
            ]
          }),
          { status: 200 }
        )
      }
      if (url.endsWith('/SHA256SUMS.txt')) {
        return new Response(`${linuxHash}  Phi-0.2.1-x86_64.AppImage\n`, { status: 200 })
      }
      return new Response(makeChunkedStream([linuxPayload]), { status: 200 })
    }) as typeof globalThis.fetch,
    openPath: async () => '',
    quitApp: () => {
      linuxQuits += 1
    },
    onWillQuit: (listener) => linuxWillQuitListeners.push(listener),
    spawnDetached: (command, args) => spawnedLinux.push({ command, args }),
    scheduleQuit: (run) => run()
  })

  await linuxManager.download()
  await linuxManager.install()
  assert.deepEqual(await readFile(appImagePath), linuxPayload)
  assert.equal(linuxQuits, 1)
  for (const listener of linuxWillQuitListeners) listener()
  assert.deepEqual(spawnedLinux, [{ command: appImagePath, args: [] }])
})
