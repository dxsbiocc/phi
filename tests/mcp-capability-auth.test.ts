import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stringify as stringifyYaml } from 'yaml'

import { refreshInstalledCapabilities } from '../src/main/agent/engine/in-process/capability-refresh'
import { createAgentInteractionRequest } from '../src/main/agent/host-requests/agent-interaction-request'
import { createMcpAuthPrompt } from '../src/main/agent/host-requests/mcp-auth-prompt'
import {
  installMcpPackageConfig,
  setMcpPackageConfigEnabled
} from '../src/main/agent/mcp/package-config'
import { isFeaturedMcpApiKeyInstalled } from '../src/main/agent/mcp-key-credentials'
import { createAppCapabilityWiring } from '../src/main/agent/packages/app-capability-wiring'
import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import { readRegistry } from '../src/main/agent/packages/installer'
import { sha256 } from '../src/main/agent/packages/installer-utils'
import {
  parsePackageManifestText,
  type McpPackageManifest
} from '../src/main/agent/packages/manifest'
import { writeRegistryManifestAsset } from '../src/main/agent/packages/manifest-assets'
import type {
  AgentUserInteractionRequest,
  McpAuthPrompt
} from '../src/shared/agentInteractionTypes'

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function writeMcpPackageSource(root: string, manifest: McpPackageManifest): string {
  const dir = join(root, manifest.id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'phi-package.yaml'), stringifyYaml(manifest))
  return dir
}

function buildTestMcpRegistry(sourceDirs: string[], outDir: string): void {
  mkdirSync(outDir, { recursive: true })
  const packages = sourceDirs.map((sourceDir) => {
    const manifestBytes = readFileSync(join(sourceDir, 'phi-package.yaml'))
    const manifest = parsePackageManifestText(manifestBytes.toString('utf8'))
    if (manifest.type !== 'mcp') throw new Error(`Expected mcp manifest: ${sourceDir}`)
    const filesJson = Buffer.from(
      `${JSON.stringify(
        {
          version: 1,
          files: [
            {
              path: 'phi-package.yaml',
              sha256: sha256(manifestBytes),
              size: manifestBytes.length
            }
          ]
        },
        null,
        2
      )}\n`
    )
    const archive = createDeterministicTarGz([
      { path: 'phi-package.yaml', data: manifestBytes },
      { path: 'files.json', data: filesJson }
    ])
    const archiveName = `mcp-${manifest.id}-${manifest.version}.tar.gz`
    writeFileSync(join(outDir, archiveName), archive)
    const manifestAsset = writeRegistryManifestAsset(manifest, manifestBytes, outDir)
    return {
      id: manifest.id,
      type: 'mcp' as const,
      version: manifest.version,
      title: manifest.title,
      summary: manifest.summary,
      archive: archiveName,
      sha256: sha256(archive),
      size: archive.length,
      dependsOn: [],
      manifestAsset
    }
  })
  writeFileSync(
    join(outDir, 'index.json'),
    `${JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-02T00:00:00Z', packages })}\n`
  )
}

test('setMcpPackageConfigEnabled keeps API-key HTTP entries disabled on disk while toggling normal HTTP entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-mcp-pkg-cfg-'))
  try {
    const tavilyManifest: McpPackageManifest = {
      schemaVersion: 1,
      id: 'tavily',
      type: 'mcp',
      version: '1.0.0',
      title: 'Tavily',
      summary: 'Web search MCP',
      connector: {
        transport: 'http',
        publisher: 'Tavily',
        category: '科研数据',
        url: 'https://mcp.tavily.com/mcp',
        auth: 'header'
      }
    }
    installMcpPackageConfig(tavilyManifest, join(root, 'pkg-tavily'), { agentDir: root })
    assert.equal(isFeaturedMcpApiKeyInstalled('tavily', root), true)

    setMcpPackageConfigEnabled('tavily', true, root)
    assert.equal(
      isFeaturedMcpApiKeyInstalled('tavily', root),
      true,
      'API-key package entry must remain disabled on disk so in-memory key injection stays active'
    )

    const publicManifest: McpPackageManifest = {
      schemaVersion: 1,
      id: 'public-http',
      type: 'mcp',
      version: '1.0.0',
      title: 'Public HTTP',
      summary: 'No-auth MCP',
      connector: {
        transport: 'http',
        publisher: 'Phi',
        category: '科研数据',
        url: 'https://public.example/mcp',
        auth: 'none'
      }
    }
    installMcpPackageConfig(publicManifest, join(root, 'pkg-public'), { agentDir: root })
    setMcpPackageConfigEnabled('public-http', false, root)
    assert.equal(
      JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8')).mcpServers['public-http'].enabled,
      false
    )
    setMcpPackageConfigEnabled('public-http', true, root)
    assert.equal(
      JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8')).mcpServers['public-http'].enabled,
      true
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agentInteraction.request validates mcpAuth prompts and rejects unsafe URLs', async () => {
  let observedRequest: AgentUserInteractionRequest | undefined
  const activeRun = {
    phiSessionId: 'phi-1',
    runId: 'run-1',
    cwd: '/workspace',
    sessionGeneration: 1,
    cancelled: false
  }
  const handler = createAgentInteractionRequest({
    fields: { optionalStringField },
    runs: {
      findByRuntimeSessionId: (id) => (id === 'runtime-1' ? activeRun : null)
    },
    projects: { getById: () => undefined, getByCwd: () => undefined },
    renderer: {
      getActiveWindow: () => ({ id: 1 }),
      waitForResponse: async (request) => {
        observedRequest = request
        return {
          requestId: request.requestId,
          mcpAuthChoice: { action: 'authenticated' },
          answers: []
        }
      }
    },
    state: {
      createId: () => 'interaction-1',
      sessionPath: (id) => `/sessions/${id}`,
      markNeedsInput: () => undefined,
      markInputCancelled: () => undefined,
      markInputAnswered: () => undefined,
      notifySessionChanged: () => undefined
    }
  })
  const promptForMcpAuth = createMcpAuthPrompt({ request: handler })

  const choice = await promptForMcpAuth({
    runtimeSessionId: 'runtime-1',
    kind: 'api-key',
    connector: {
      id: 'tavily',
      title: 'Tavily',
      publisher: 'Tavily',
      obtainUrl: 'https://app.tavily.com/home'
    }
  })
  assert.deepEqual(choice, { action: 'authenticated' })
  assert.equal(observedRequest?.mcpAuth?.kind, 'api-key')
  assert.equal(observedRequest?.mcpAuth?.connector.id, 'tavily')

  await assert.rejects(
    () =>
      handler({
        runtimeSessionId: 'runtime-1',
        questions: [
          {
            header: 'Connector',
            question: 'Sign in',
            options: [{ label: 'Sign in', description: 'Open browser' }]
          }
        ],
        mcpAuth: {
          runtimeSessionId: 'runtime-1',
          kind: 'oauth',
          connector: {
            id: 'notion',
            title: 'Notion',
            publisher: 'Notion',
            authorizationOrigin: 'http://insecure.example'
          }
        }
      }),
    /Invalid MCP authentication interaction request/
  )
})

test('capability search and install trigger inline MCP authentication and skip redundant re-enable approval when already enabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-mcp-cap-auth-'))
  try {
    const sourcesDir = join(root, 'sources')
    const registryDir = join(root, 'registry')
    const agentDir = join(root, 'agent')
    const runtimeRoot = join(root, 'runtime')
    const notionSource = writeMcpPackageSource(sourcesDir, {
      schemaVersion: 1,
      id: 'notion',
      type: 'mcp',
      version: '1.0.0',
      title: 'Notion',
      summary: 'Notion workspace MCP',
      connector: {
        transport: 'http',
        publisher: 'Notion Labs',
        category: '生产力',
        url: 'https://mcp.notion.com/mcp',
        auth: 'oauth',
        homepage: 'https://developers.notion.com'
      }
    })
    const tavilySource = writeMcpPackageSource(sourcesDir, {
      schemaVersion: 1,
      id: 'tavily',
      type: 'mcp',
      version: '1.0.0',
      title: 'Tavily',
      summary: 'Tavily web search MCP',
      connector: {
        transport: 'http',
        publisher: 'Tavily',
        category: '科研数据',
        url: 'https://mcp.tavily.com/mcp',
        auth: 'header'
      }
    })
    buildTestMcpRegistry([notionSource, tavilySource], registryDir)
    const registry = { ...readRegistry(registryDir), trust: 'official' as const }

    let notionSignedIn = false
    let tavilyVerified = false
    let installApprovals = 0
    const authPrompts: McpAuthPrompt[] = []
    let nextAuthAction: 'authenticated' | 'cancel' = 'cancel'

    const { capabilityHost } = createAppCapabilityWiring({
      agentDir,
      appVersion: '0.1.8',
      getRuntimeRoot: () => runtimeRoot,
      loadPackageRegistries: async () => ({ registries: [registry], errors: [] }),
      officialRegistryFetch: (async () => {
        throw new Error('offline in test')
      }) as typeof fetch,
      officialContentSourceOptions: () => ({ agentDir, appVersion: '0.1.8' }),
      installedPluginNamespace: async () => undefined,
      environmentBuilds: {
        start: async () => {
          throw new Error('unexpected environment build')
        }
      },
      confirmAgentModuleInstallation: async () => {
        installApprovals += 1
        return true
      },
      promptForMcpAuth: async (prompt) => {
        authPrompts.push(prompt)
        if (nextAuthAction === 'authenticated') {
          if (prompt.connector.id === 'notion') notionSignedIn = true
          if (prompt.connector.id === 'tavily') tavilyVerified = true
          return { action: 'authenticated' }
        }
        return { action: 'cancel' }
      },
      featuredAuthStatus: async (id) => id === 'notion' && notionSignedIn,
      featuredApiKeyVerifiedStatus: async (id) => id === 'tavily' && tavilyVerified,
      onResourcesChanged: () => undefined,
      resolveRun: () => ({ assertCurrent: () => undefined })
    })

    const callContext = { originSessionId: 'runtime-1', toolCallId: 'tool-1' }

    // 1. Search reports authRequired & authenticated: false for unauthenticated Notion MCP
    const firstSearch = (await capabilityHost.handlers['capabilities.search'](
      {
        runtimeSessionId: 'runtime-1',
        toolCallId: 'tool-1',
        requestId: 'req-search-1',
        query: 'notion',
        type: 'mcp'
      },
      callContext
    )) as { candidates: Array<Record<string, unknown>> }
    assert.equal(firstSearch.candidates.length, 1)
    assert.equal(firstSearch.candidates[0].authRequired, 'oauth')
    assert.equal(firstSearch.candidates[0].authenticated, false)

    // 2. Install Notion, user skips OAuth for now -> receipt says status: 'cancelled'
    nextAuthAction = 'cancel'
    const firstInstall = (await capabilityHost.handlers['capabilities.install'](
      {
        runtimeSessionId: 'runtime-1',
        toolCallId: 'tool-1',
        requestId: 'req-install-1',
        candidateId: firstSearch.candidates[0].candidateId,
        reason: 'Read lab notes from Notion'
      },
      callContext
    )) as Record<string, unknown>
    assert.equal(installApprovals, 1)
    assert.equal(authPrompts.length, 1)
    assert.equal(authPrompts[0].kind, 'oauth')
    assert.deepEqual(firstInstall.authentication, [
      {
        id: 'notion',
        kind: 'oauth',
        status: 'cancelled',
        homepageUrl: 'https://developers.notion.com'
      }
    ])

    // Refresh skips connecting a connector whose authentication was cancelled
    const refreshedConnectors: string[] = []
    await refreshInstalledCapabilities(firstInstall, {
      reloadResources: async () => undefined,
      refreshSkills: async () => undefined,
      refreshTools: async () => undefined,
      refreshConnector: async (name) => {
        refreshedConnectors.push(name)
      }
    })
    assert.equal(refreshedConnectors.length, 0)

    // 3. Second search sees Notion installed & enabled, but authenticated: false.
    // Calling capability_install again skips redundant install approval and goes straight to OAuth!
    const secondSearch = (await capabilityHost.handlers['capabilities.search'](
      {
        runtimeSessionId: 'runtime-1',
        toolCallId: 'tool-2',
        requestId: 'req-search-2',
        query: 'notion',
        type: 'mcp'
      },
      { originSessionId: 'runtime-1', toolCallId: 'tool-2' }
    )) as { candidates: Array<Record<string, unknown>> }
    assert.equal(secondSearch.candidates[0].installed, true)
    assert.equal(secondSearch.candidates[0].enabled, true)
    assert.equal(secondSearch.candidates[0].authenticated, false)

    nextAuthAction = 'authenticated'
    const secondInstall = (await capabilityHost.handlers['capabilities.install'](
      {
        runtimeSessionId: 'runtime-1',
        toolCallId: 'tool-2',
        requestId: 'req-install-2',
        candidateId: secondSearch.candidates[0].candidateId,
        reason: 'Complete Notion sign-in'
      },
      { originSessionId: 'runtime-1', toolCallId: 'tool-2' }
    )) as Record<string, unknown>
    assert.equal(
      installApprovals,
      1,
      'already installed+enabled connector skips redundant approval'
    )
    assert.equal(authPrompts.length, 2)
    assert.deepEqual(secondInstall.authentication, [
      {
        id: 'notion',
        kind: 'oauth',
        status: 'authenticated',
        homepageUrl: 'https://developers.notion.com'
      }
    ])

    await refreshInstalledCapabilities(secondInstall, {
      reloadResources: async () => undefined,
      refreshSkills: async () => undefined,
      refreshTools: async () => undefined,
      refreshConnector: async (name) => {
        refreshedConnectors.push(name)
      }
    })
    assert.deepEqual(refreshedConnectors, ['notion'])

    // 4. Install API-key connector Tavily -> keeps disk enabled: false and prompts for API key in chat
    const tavilySearch = (await capabilityHost.handlers['capabilities.search'](
      {
        runtimeSessionId: 'runtime-1',
        toolCallId: 'tool-3',
        requestId: 'req-search-3',
        query: 'tavily',
        type: 'mcp'
      },
      { originSessionId: 'runtime-1', toolCallId: 'tool-3' }
    )) as { candidates: Array<Record<string, unknown>> }
    assert.equal(tavilySearch.candidates[0].authRequired, 'api-key')

    const tavilyInstall = (await capabilityHost.handlers['capabilities.install'](
      {
        runtimeSessionId: 'runtime-1',
        toolCallId: 'tool-3',
        requestId: 'req-install-3',
        candidateId: tavilySearch.candidates[0].candidateId,
        reason: 'Search scientific web pages'
      },
      { originSessionId: 'runtime-1', toolCallId: 'tool-3' }
    )) as Record<string, unknown>
    assert.equal(installApprovals, 2)
    assert.equal(authPrompts[2].kind, 'api-key')
    if (authPrompts[2].kind === 'api-key') {
      assert.equal(authPrompts[2].connector.obtainUrl, 'https://app.tavily.com/home')
    }
    assert.equal(isFeaturedMcpApiKeyInstalled('tavily', agentDir), true)
    assert.deepEqual(tavilyInstall.authentication, [
      {
        id: 'tavily',
        kind: 'api-key',
        status: 'authenticated'
      }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
