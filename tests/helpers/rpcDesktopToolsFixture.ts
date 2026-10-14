import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTextVault } from '../../src/main/agent/browser/browser-text-vault'
import { BrowserToolHostCoordinator } from '../../src/main/agent/browser/browser-tool-host'
import { HostServiceRegistry } from '../../src/main/agent/engine/host-service-registry'
import {
  createRpcDesktopToolScope,
  type RpcDesktopToolScope,
  type RpcDesktopToolRun
} from '../../src/main/agent/engine/rpc/desktop-tool-scope'
import type {
  PhiHostRequestContext,
  PhiTool,
  PhiToolResult,
  PhiToolApproval,
  PhiHostRequestHandler
} from '../../src/main/agent/engine/types'
import type { BrowserOutcome } from '../../src/shared/browserTypes'
import type { ScriptToolDescriptor } from '../../src/main/agent/content/skill-tool-types'

export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII='
export function browserOutcome(): BrowserOutcome {
  return {
    ok: true,
    snapshot: {
      sessionId: 'phi-session',
      activeTabId: 'tab-1',
      revision: 3,
      capabilities: {
        presentation: 'native',
        screenshot: true,
        coordinateInput: true,
        semanticInspection: false,
        downloads: false,
        recording: false,
        persistentProfile: false
      },
      tabs: [
        {
          id: 'tab-1',
          title: 'Fixture',
          url: 'https://fixture.test/',
          origin: 'https://fixture.test',
          phase: 'ready',
          canGoBack: false,
          canGoForward: false,
          isAgentControlled: true,
          documentRevision: 2
        }
      ]
    },
    screenshot: {
      mediaType: 'image/png',
      data: PNG,
      width: 1,
      height: 1,
      tabId: 'tab-1',
      url: 'https://fixture.test/',
      documentRevision: 2
    }
  }
}
export interface DesktopToolsFixture {
  root: string
  scope: RpcDesktopToolScope
  services: HostServiceRegistry
  vault: BrowserTextVault
  controller: AbortController
  observed: Array<{ params: unknown; context: PhiHostRequestContext }>
  browser: BrowserToolHostCoordinator
  browserHandler: PhiHostRequestHandler
  setRun(run?: RpcDesktopToolRun): void
  setTypeAllowed(allowed: boolean): void
  call(
    name: string,
    input?: Record<string, unknown>,
    id?: string,
    signal?: AbortSignal
  ): Promise<PhiToolResult>
  tool(name: string): PhiTool
  close(): void
}
export function desktopToolsFixture(
  options: {
    cwd?: string
    identity?: { runtimeSessionId: string; sessionId: string; projectId: string }
    currentRun?: () => RpcDesktopToolRun | undefined
    scriptTools?: readonly ScriptToolDescriptor[]
    scriptApprovalFor?: (toolName: string, input: unknown) => PhiToolApproval | undefined
    executeBrowser?: (input: unknown, signal: AbortSignal) => Promise<BrowserOutcome>
  } = {}
): DesktopToolsFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phi-rpc-desktop-tools-')))
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { mode: 0o700 })
  const services = new HostServiceRegistry()
  const controller = new AbortController()
  let run: RpcDesktopToolRun | undefined = {
    id: 'phi-main-run',
    signal: controller.signal
  }
  let typeAllowed = true
  const identity = options.identity ?? {
    runtimeSessionId: 'runtime-session',
    sessionId: 'phi-session',
    projectId: 'project'
  }
  const currentRun = options.currentRun ?? (() => run)
  const observed: DesktopToolsFixture['observed'] = []
  const vault = new BrowserTextVault()
  const browser = new BrowserToolHostCoordinator({
    resolveActiveRun: (origin) => {
      const active = currentRun()
      return origin === identity.runtimeSessionId && active
        ? { runId: active.id, cancelled: active.signal.aborted }
        : undefined
    },
    executeAgent: options.executeBrowser ?? (async () => browserOutcome())
  })
  const browserHandler: PhiHostRequestHandler = (params, context) => {
    observed.push({ params, context })
    return browser.execute(params)
  }
  services.register('browser.execute', browserHandler)
  services.register('browser.cancel', (params, context) => {
    observed.push({ params, context })
    return browser.cancel(params)
  })
  const scope = createRpcDesktopToolScope({
    identity: {
      ...identity,
      cwd: options.cwd ?? '/server/project'
    },
    services,
    currentRun,
    recentUserImages: () => [{ type: 'image', mimeType: 'image/png', data: PNG }],
    allowBrowserTypeText: () => typeAllowed,
    browserTextVault: vault,
    agentDir,
    paletteCatalogPath: join(process.cwd(), 'resources/palettes/palettes.yaml'),
    allowedSkills: ['remote-demo'],
    scriptTools: options.scriptTools ?? [],
    ...(options.scriptApprovalFor ? { scriptApprovalFor: options.scriptApprovalFor } : {})
  })
  const tool = (name: string): PhiTool => {
    const found = scope.tools.find((item) => item.name === name)
    if (!found) throw new Error(`Missing desktop tool ${name}`)
    return found
  }
  let count = 0
  return {
    root,
    scope,
    services,
    vault,
    controller,
    observed,
    browser,
    browserHandler,
    tool,
    setRun: (next) => {
      run = next
    },
    setTypeAllowed: (allowed) => {
      typeAllowed = allowed
    },
    call: (name, input = {}, id = `call-${++count}`, signal) =>
      tool(name).execute(
        id,
        input,
        undefined,
        { cwd: scope.identity.cwd, recentUserImages: () => [] },
        signal
      ),
    close() {
      scope.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
