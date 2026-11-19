/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_NAME = 'Phi Dev'
const ELECTRON_NAME = 'Electron'
const LAUNCHER =
  [
    "import { app, dialog } from 'electron'",
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "import { pathToFileURL } from 'node:url'",
    'try {',
    "  const { checkout, entry } = JSON.parse(readFileSync(join(import.meta.dirname, 'source.json'), 'utf8'))",
    '  process.chdir(checkout)',
    '  app.setAppPath(checkout)',
    // electron-vite supplies the live renderer URL on dev launches. LaunchServices
    // restarts this embedded entry with no watcher arguments and uses out/renderer.
    "  if (process.env.PHI_SOURCE_WATCHER !== '1') delete process.env.ELECTRON_RENDERER_URL",
    '  await import(pathToFileURL(join(checkout, entry)).href)',
    '} catch (error) {',
    "  console.error('[Phi] Source startup failed', error)",
    "  const zh = app.getPreferredSystemLanguages().some((language) => language.startsWith('zh'))",
    "  dialog.showErrorBox('Phi', zh ? 'Phi 源码启动失败。请在项目目录运行 bun run dev。' : 'Could not start Phi from source. Run bun run dev in the checkout.')",
    '  app.exit(1)',
    '}'
  ].join('\n') + '\n'

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(command + ' exited with ' + (result.signal ?? result.status))
  }
}

function digest(...parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

function replaceBundle(stage, destination, backup) {
  if (existsSync(destination)) renameSync(destination, backup)
  try {
    renameSync(stage, destination)
  } catch (error) {
    if (existsSync(backup)) renameSync(backup, destination)
    throw error
  }
}

export function sourceBundleId(root) {
  return 'cn.phiscience.phi.source.' + digest(realpathSync(root)).slice(0, 16)
}

export function sourceAppPath(root) {
  return join(root, '.phi-build', 'source-app', APP_NAME + '.app')
}

export function ensureSourceApp(root, { electronAppPath, sign = true } = {}) {
  const checkout = realpathSync(root)
  const projectRequire = createRequire(join(checkout, 'package.json'))
  const sdk = electronAppPath ?? resolve(dirname(projectRequire('electron')), '../..')
  const metadata = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'))
  const entry = relative(checkout, resolve(checkout, metadata.main))
  if (!entry.startsWith('out/main/')) throw new Error('Phi entry must be inside out/main.')
  const bundleId = sourceBundleId(checkout)
  const destination = sourceAppPath(checkout)
  const icon = join(checkout, 'build', 'icon.icns')
  const source = JSON.stringify({ checkout, entry, bundleId, version: metadata.version })
  const sdkPlist = join(sdk, 'Contents/Info.plist')
  const cacheKey = digest(
    source,
    readFileSync(fileURLToPath(import.meta.url)),
    readFileSync(icon),
    readFileSync(sdkPlist),
    readFileSync(join(sdk, 'Contents/MacOS', ELECTRON_NAME)),
    String(sign)
  )
  const relativeEmbedded = 'Contents/Resources/app'
  const cacheFile = join(relativeEmbedded, 'bundle-key')
  if (
    existsSync(join(destination, cacheFile)) &&
    readFileSync(join(destination, cacheFile), 'utf8') === cacheKey &&
    existsSync(join(destination, 'Contents/Info.plist')) &&
    existsSync(join(destination, 'Contents/Resources/icon.icns')) &&
    existsSync(join(destination, relativeEmbedded, 'source.json')) &&
    existsSync(join(destination, relativeEmbedded, 'main.mjs')) &&
    existsSync(join(destination, 'Contents/MacOS', ELECTRON_NAME))
  ) {
    return { appPath: destination, bundleId, prepared: false }
  }

  mkdirSync(dirname(destination), { recursive: true })
  const staging = mkdtempSync(join(dirname(destination), '.stage-'))
  const bundle = join(staging, APP_NAME + '.app')
  try {
    run('/usr/bin/ditto', [sdk, bundle])
    const plist = join(bundle, 'Contents/Info.plist')
    for (const [key, value] of Object.entries({
      CFBundleIdentifier: bundleId,
      CFBundleName: APP_NAME,
      CFBundleDisplayName: APP_NAME,
      CFBundleIconFile: 'icon.icns',
      CFBundleShortVersionString: metadata.version.split('-')[0]
    })) {
      run('/usr/bin/plutil', ['-replace', key, '-string', value, plist])
    }
    const resources = join(bundle, 'Contents/Resources')
    const embedded = join(bundle, relativeEmbedded)
    // The SDK's sample app cannot run from this bundle even if Phi's build is missing.
    rmSync(join(resources, 'default_app.asar'), { force: true })
    mkdirSync(embedded)
    copyFileSync(icon, join(resources, 'icon.icns'))
    writeFileSync(
      join(embedded, 'package.json'),
      JSON.stringify({
        name: 'phi',
        productName: 'Phi',
        version: metadata.version,
        main: 'main.mjs'
      })
    )
    writeFileSync(join(embedded, 'source.json'), source)
    writeFileSync(join(embedded, 'main.mjs'), LAUNCHER)
    writeFileSync(join(bundle, cacheFile), cacheKey)
    // Keep the upstream executable basename and helper layout. Electron treats
    // this as unpackaged, even though macOS sees a real, branded application.
    if (sign) {
      run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle])
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
    }
    replaceBundle(bundle, destination, join(staging, 'previous.app'))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  return { appPath: destination, bundleId, prepared: true }
}

function projectRoot() {
  return realpathSync(fileURLToPath(new URL('../', import.meta.url)))
}

async function buildColdRenderer(root) {
  const { resolveConfig } = await import('electron-vite')
  const { build } = await import('vite')
  process.env.NODE_ENV_ELECTRON_VITE = 'production'
  const { config } = await resolveConfig({ root }, 'build', 'production')
  if (!config?.renderer) throw new Error('Phi renderer configuration was not loaded.')
  await build(config.renderer)
}

async function main() {
  const [command, mode, ...extraArgs] = process.argv.slice(2)
  const root = projectRoot()
  process.chdir(root)
  const generate = process.platform === 'darwin' && !process.env.ELECTRON_EXEC_PATH
  if (command === 'open' && process.platform === 'darwin') {
    run('/usr/bin/open', ['-a', ensureSourceApp(root).appPath])
    return
  }
  if (command !== 'run' || !['dev', 'preview'].includes(mode)) {
    throw new Error('Use dev-app.mjs run dev|preview or dev-app.mjs open on macOS.')
  }
  const env = { ...process.env }
  delete env.PHI_SOURCE_WATCHER
  if (generate) {
    if (mode === 'dev') {
      // The Vite watcher is gone after Quit. Build the same renderer so the
      // same bundle can reopen directly from the Dock without a terminal.
      await buildColdRenderer(root)
      env.PHI_SOURCE_WATCHER = '1'
    }
    const { appPath } = ensureSourceApp(root)
    env.ELECTRON_EXEC_PATH = join(appPath, 'Contents/MacOS', ELECTRON_NAME)
  }
  const require = createRequire(join(root, 'package.json'))
  const vite = join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
  const child = spawn(process.execPath, [vite, mode, ...extraArgs], {
    cwd: root,
    env,
    stdio: 'inherit'
  })
  child.on('error', (error) => {
    console.error('[Phi] ' + error.message)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error('[Phi] ' + error.message)
    process.exitCode = 1
  })
}
