// Run with node --import ./scripts/test-loader.mjs from a built Phi checkout.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { launchPackagedExecutable } from '../../gui-e2e/app-launcher.ts'
import { prepareDesktopProfile } from './desktop-profile.mjs'
import { runDesktopCases } from './desktop-ui.mjs'

const mode = process.env.PHI_DESKTOP_DRIVER ?? 'regression'
assert(['model', 'regression', 'moonshot'].includes(mode), 'Choose regression, model or moonshot')
const moonshot = mode === 'moonshot'
const moonshotUrl = 'https://api.moonshot.cn/v1'
const cases = process.argv.slice(2)
assert(
  cases.every((name) => ['paired', 'zero'].includes(name)),
  'Expected paired or zero'
)
const packagesRoot = process.env.PHI_PACKAGES_ROOT
assert(packagesRoot && existsSync(join(packagesRoot, 'resources/plugins/differential-expression')))
assert(existsSync('out/main/index.mjs'), 'Build with electron-vite first.')
const providerId = moonshot ? 'moonshot' : 'phi-local-acceptance'
const modelId = moonshot
  ? 'kimi-k3'
  : mode === 'model'
    ? process.env.PHI_DESKTOP_MODEL
    : 'deseq2-regression'
assert(modelId, 'Set PHI_DESKTOP_MODEL to a model served on this machine')
const contextWindow = Number(process.env.PHI_DESKTOP_CONTEXT ?? 32768)
assert(Number.isSafeInteger(contextWindow) && contextWindow > 4096, 'Invalid model context size')
const profile = await prepareDesktopProfile({ packagesRoot, model: { providerId, modelId } })
const evidenceDir = process.env.PHI_DESKTOP_EVIDENCE
  ? resolve(process.env.PHI_DESKTOP_EVIDENCE)
  : join(profile.root, 'desktop-evidence')
mkdirSync(evidenceDir, { recursive: true })
const summaryFile = join(evidenceDir, 'report.json')
assert(!existsSync(summaryFile), 'Use a fresh desktop evidence directory for each run.')
console.log('Isolated desktop profile:', profile.root, '\nEvidence:', evidenceDir)
const revision = (cwd) =>
  execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const report = {
  driver: mode,
  model: modelId,
  started: new Date().toISOString(),
  phiRevision: revision(process.cwd()),
  packagesRevision: revision(packagesRoot),
  profile: profile.root,
  cases: {},
  status: 'running'
}
function save() {
  writeFileSync(summaryFile, JSON.stringify(report, null, 2) + '\n')
}
async function configureLoopbackProvider(fixture) {
  const endpoint = fixture?.url ?? process.env.PHI_DESKTOP_MODEL_URL
  assert(endpoint, 'Set PHI_DESKTOP_MODEL_URL to the local OpenAI-compatible /v1 endpoint')
  const url = new URL(endpoint)
  assert(
    url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password,
    'The acceptance model endpoint must be HTTP on 127.0.0.1.'
  )
  const baseUrl = url.href.replace(/\/$/, '')
  if (!fixture) {
    const response = await fetch(baseUrl + '/models', {
      signal: AbortSignal.timeout(5000),
      redirect: 'error'
    })
    assert(
      response.ok && (await response.json()).data.some((m) => m.id === modelId),
      'Loopback server must advertise the selected model'
    )
  }
  const token = fixture?.token ?? 'local-' + randomUUID()
  const providers = {
    [providerId]: {
      baseUrl,
      apiKey: token,
      api: 'openai-completions',
      models: [
        {
          id: modelId,
          name: modelId,
          input: ['text'],
          reasoning: false,
          contextWindow,
          compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }
      ]
    }
  }
  writeFileSync(join(profile.agentDir, 'models.yml'), JSON.stringify({ providers }), {
    mode: 0o600
  })
  return baseUrl
}
save()
let app, fixture, clearCredential
try {
  if (mode === 'regression') {
    const { startRegressionProvider } = await import('./desktop-regression-provider.mjs')
    fixture = await startRegressionProvider(profile)
  }
  if (moonshot) {
    report.endpoint = moonshotUrl
    const { prepareMoonshotCredential } = await import('./desktop-moonshot.mjs')
    clearCredential = await prepareMoonshotCredential(profile)
  } else {
    report.endpoint = await configureLoopbackProvider(fixture)
  }
  writeFileSync(
    join(profile.agentDir, 'config.yml'),
    JSON.stringify({
      defaultProvider: providerId,
      defaultModel: modelId,
      mcp: { enableProjectConfig: false }
    })
  )
  const settings = join(profile.agentDir, 'settings.json')
  writeFileSync(
    settings,
    JSON.stringify({
      ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}),
      uiLanguage: 'zh-CN',
      nextActionSuggestionsEnabled: false,
      lastSelectedModel: { providerId, modelId }
    })
  )
  app = await launchPackagedExecutable(electron, {
    cwd: process.cwd(),
    userData: profile.userData,
    env: {
      ...profile.env,
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: ['127.0.0.1', 'localhost', '::1', ...(moonshot ? ['api.moonshot.cn'] : [])].join(
        ','
      ),
      ...(moonshot ? { MOONSHOT_BASE_URL: moonshotUrl } : {})
    },
    args: [
      '--disable-background-networking',
      '--use-mock-keychain',
      '--password-store=basic',
      '--proxy-server=http://127.0.0.1:9',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
      '.'
    ]
  })
  console.log('Desktop ready:', app.mode)
  report.cases = await runDesktopCases({
    page: app.page,
    profile,
    model: modelId,
    providerId,
    timeoutMs: mode === 'model' ? 45 * 60_000 : 15 * 60_000,
    evidenceDir,
    ...(cases.length ? { cases } : {}),
    onCase: (name, result) => {
      report.cases[name] = result
      save()
      console.log('Finished:', name, result.status ?? '')
    }
  })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.message
  process.exitCode = 1
  console.error(error)
} finally {
  report.finished = new Date().toISOString()
  if (fixture) report.regressionTrace = fixture.trace
  save()
  try {
    await app?.close()
  } finally {
    try {
      await fixture?.close()
    } finally {
      await clearCredential?.()
    }
  }
  console.log('Desktop acceptance report:', summaryFile)
}
