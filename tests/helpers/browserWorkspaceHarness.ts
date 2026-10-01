import assert from 'node:assert/strict'
import type { BrowserCapabilities, BrowserOutcome } from '../../src/shared/browserTypes'
import type { EngineTabHandle } from '../../src/main/browser/browser-engine'
import { InMemoryBrowserEngine } from '../../src/main/browser/in-memory-browser-engine'
import { BrowserWorkspace } from '../../src/main/browser/browser-workspace'

export const human = { kind: 'human' } as const

export const browserCapabilities: BrowserCapabilities = {
  presentation: 'native',
  screenshot: true,
  coordinateInput: true,
  semanticInspection: false,
  downloads: false,
  recording: false,
  persistentProfile: false
}

export interface BrowserWorkspaceHarness {
  engine: InMemoryBrowserEngine
  workspace: BrowserWorkspace
  engineHandle: EngineTabHandle
}

export function createBrowserWorkspaceHarness(
  options: { recentRequestCap?: number } = {}
): BrowserWorkspaceHarness {
  const engineHandle = 'engine-tab-1' as EngineTabHandle
  let engineId = 0
  let tabId = 0
  const engine = new InMemoryBrowserEngine({
    capabilities: browserCapabilities,
    idFactory: () => `engine-tab-${++engineId}`,
    now: () => 42
  })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    policyContext: { applicationOrigins: ['https://phi.internal'] },
    idFactory: () => `phi-tab-${++tabId}`,
    now: () => 42,
    recentRequestCap: options.recentRequestCap
  })
  return { engine, workspace, engineHandle }
}

export function successful(
  outcome: BrowserOutcome
): asserts outcome is Extract<BrowserOutcome, { ok: true }> {
  assert.equal(outcome.ok, true)
}
