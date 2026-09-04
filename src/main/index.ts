import './agent-env'
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createAgentSession } from './agent/session-manager'
import { getAuthManager } from './agent/auth-manager'
import icon from '../../resources/icon.png?asset'

type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

let sharedAgentSession: Promise<Awaited<ReturnType<typeof createAgentSession>>> | null = null
let selectedModel: { providerId: string; modelId: string } | null = null
// Default is deliberately 'high', not the SDK's own default of 'off': many models
// (e.g. DeepSeek V4 Pro) only enable reasoning output at 'high'/'max', and this app
// wants that reasoning visible in the UI out of the box rather than silently absent.
let selectedThinkingLevel: ThinkingLevel = 'high'
let promptQueue: Promise<void> = Promise.resolve()

async function runPiSmokeSession(): Promise<void> {
  try {
    const { session } = await getAgentSession()
    await session.prompt('reply with exactly: OK')
  } catch (error) {
    console.error('PI smoke test failed:', error)
  }
}

function getActiveWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ??
    null
  )
}

function invalidateAgentSession(): void {
  sharedAgentSession = null
}

async function getAgentSession(): Promise<Awaited<ReturnType<typeof createAgentSession>>> {
  if (!sharedAgentSession) {
    // Cache the in-flight promise synchronously (before any await) so concurrent
    // callers share it instead of each racing to create their own session — an
    // `await` before this assignment would let a second call slip through the
    // `!sharedAgentSession` check while the first is still resolving.
    sharedAgentSession = (async () => {
      const runtime = await getAuthManager().getRuntime()
      const model = selectedModel
        ? runtime.getModel(selectedModel.providerId, selectedModel.modelId)
        : undefined
      const result = await createAgentSession({
        modelRuntime: runtime,
        thinkingLevel: selectedThinkingLevel,
        ...(model ? { model } : {})
      })

      result.session.subscribe((summary) => {
        const targetWindow = getActiveWindow()
        if (targetWindow && !targetWindow.isDestroyed()) {
          targetWindow.webContents.send('agent:event', summary)
        }
      })

      return result
    })().catch((error) => {
      sharedAgentSession = null
      throw error
    })
  }

  return sharedAgentSession
}

function createWindow(): void {
  // Create the browser window.
  const window = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.handle('agent:prompt', async (_, text: string) => {
    const normalizedText = text.trim()
    if (!normalizedText) return

    // Serialize prompts onto the shared session: a duplicate/overlapping IPC
    // invoke must never run session.prompt() concurrently with another one.
    const run = promptQueue.then(async () => {
      const { session } = await getAgentSession()
      await session.prompt(normalizedText)
    })
    promptQueue = run.catch(() => {})
    await run
  })

  ipcMain.handle('auth:status', async () => getAuthManager().getProviderStatuses())
  ipcMain.handle('auth:loginApiKey', async (_, providerId: string, key: string) => {
    const normalizedKey = key.trim()
    const status = await getAuthManager().loginApiKey(providerId, normalizedKey)
    invalidateAgentSession()
    return status
  })
  ipcMain.handle('auth:loginOAuth', async (_, providerId: string) => {
    const status = await getAuthManager().loginOAuth(providerId)
    invalidateAgentSession()
    return status
  })
  ipcMain.handle('auth:logout', async (_, providerId: string) => {
    await getAuthManager().logout(providerId)
    invalidateAgentSession()
  })
  ipcMain.handle('auth:interaction-response', async (_, requestId: string, value: string) => {
    await getAuthManager().resolveInteraction(requestId, value)
  })

  ipcMain.handle('models:list', async () => {
    const runtime = await getAuthManager().getRuntime()
    return runtime.getModels().map((model) => ({
      providerId: model.provider,
      modelId: model.id,
      name: model.name
    }))
  })
  ipcMain.handle('models:select', async (_, providerId: string, modelId: string) => {
    const runtime = await getAuthManager().getRuntime()
    const model = runtime.getModel(providerId, modelId)
    if (!model) {
      throw new Error(`未知模型: ${providerId}/${modelId}`)
    }

    selectedModel = { providerId, modelId }
    if (sharedAgentSession) {
      const { session } = await sharedAgentSession
      await session.setModel(model)
    }
  })
  ipcMain.handle('models:selected', async () => {
    if (selectedModel) return selectedModel
    if (!sharedAgentSession) return null

    const { session } = await sharedAgentSession
    const model = session.model
    return model ? { providerId: model.provider, modelId: model.id } : null
  })

  ipcMain.handle('thinking:select', async (_, level: ThinkingLevel) => {
    selectedThinkingLevel = level
    if (sharedAgentSession) {
      const { session } = await sharedAgentSession
      session.setThinkingLevel(level)
    }
  })
  ipcMain.handle('thinking:selected', async () => {
    if (sharedAgentSession) {
      const { session } = await sharedAgentSession
      return session.thinkingLevel
    }
    return selectedThinkingLevel
  })

  if (process.env['PI_SMOKE'] === '1') {
    void runPiSmokeSession()
  }

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
