import { posix } from 'node:path'
import type { WorkspaceHost } from '../../workspace-host/types'
import { shellQuote as q } from '../../wrappers/remote-ssh-session'

const MAX_PLUGIN_JSON_BYTES = 512 * 1024
const PLUGIN_INDEX_NAMES = ['index.ts', 'index.js', 'index.mjs', 'index.cjs'] as const
const PROJECT_CONFIG_DIRS = ['.omp', '.claude', '.codex', '.gemini'] as const
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u

type JsonObject = Record<string, unknown>

interface PluginRuntimeState {
  readonly enabled: boolean
  readonly enabledFeatures: readonly string[] | null
}

interface ProjectPluginOverrides {
  readonly disabled: ReadonlySet<string>
  readonly features: ReadonlyMap<string, readonly string[]>
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Cannot inspect project plugins: invalid ${label}`)
  return value as JsonObject
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string'))
    throw new Error(`Cannot inspect project plugins: invalid ${label}`)
  return value
}

async function runReadOnly(
  host: WorkspaceHost,
  cwd: string,
  command: string,
  signal: AbortSignal,
  maxOutputBytes = MAX_PLUGIN_JSON_BYTES
): Promise<Awaited<ReturnType<WorkspaceHost['exec']['run']>>> {
  signal.throwIfAborted()
  const result = await host.exec.run(['sh', '-c', command], {
    cwd,
    signal,
    timeoutMs: 30_000,
    maxOutputBytes
  })
  signal.throwIfAborted()
  return result
}

async function readJson(
  host: WorkspaceHost,
  cwd: string,
  path: string,
  signal: AbortSignal
): Promise<unknown | undefined> {
  const result = await runReadOnly(
    host,
    cwd,
    `if [ ! -e ${q(path)} ]; then exit 44; fi\n[ -f ${q(path)} ] || exit 45\ncat -- ${q(path)}`,
    signal
  )
  if (result.code === 44) return undefined
  if (result.code !== 0 || result.truncated || result.terminationReason)
    throw new Error(`Cannot inspect project plugin metadata: ${path}`)
  try {
    return JSON.parse(result.stdout) as unknown
  } catch {
    throw new Error(`Cannot inspect project plugin metadata: invalid JSON at ${path}`)
  }
}

async function activeProjectPluginsRoot(
  host: WorkspaceHost,
  executionRoot: string,
  projectRoot: string,
  signal: AbortSignal
): Promise<string | undefined> {
  const result = await runReadOnly(
    host,
    executionRoot,
    `cd -P -- ${q(projectRoot)} || exit 70
[ "$(pwd -P)" = ${q(projectRoot)} ] || exit 70
start=$(pwd -P) || exit 70
home=$(cd && pwd -P) || exit 70
dir=$start
while [ "$dir" != "$home" ]; do
  if [ -d "$dir/.omp" ]; then printf '%s\\n' "$dir/.omp/plugins"; exit 0; fi
  [ "$dir" != / ] || break
  parent=\${dir%/*}; [ -n "$parent" ] || parent=/; dir=$parent
done
dir=$start
while [ "$dir" != "$home" ]; do
  if [ -e "$dir/.git" ]; then printf '%s\\n' "$dir/.omp/plugins"; exit 0; fi
  [ "$dir" != / ] || break
  parent=\${dir%/*}; [ -n "$parent" ] || parent=/; dir=$parent
done`,
    signal,
    4096
  )
  if (result.code !== 0 || result.truncated || result.terminationReason)
    throw new Error('Cannot inspect the active project plugin root')
  const root = result.stdout.trim()
  if (!root) return undefined
  if (!posix.isAbsolute(root) || posix.normalize(root) !== root || /[\0\r\n]/u.test(root))
    throw new Error('Cannot inspect the active project plugin root')
  return root
}

async function isSymlink(
  host: WorkspaceHost,
  cwd: string,
  path: string,
  signal: AbortSignal
): Promise<boolean> {
  const result = await runReadOnly(host, cwd, `[ -L ${q(path)} ]`, signal, 1024)
  if (result.code === 0) return true
  if (result.code === 1) return false
  throw new Error(`Cannot inspect project plugin path: ${path}`)
}

async function resolveToolModule(
  host: WorkspaceHost,
  cwd: string,
  pluginRoot: string,
  entry: string,
  signal: AbortSignal
): Promise<string | undefined> {
  if (!entry || entry.includes('\0'))
    throw new Error('Cannot inspect project plugins: invalid tool entry')
  const joined = posix.join(pluginRoot, entry)
  const result = await runReadOnly(
    host,
    cwd,
    `if [ -f ${q(joined)} ]; then printf '%s\\n' ${q(joined)}; exit 0; fi
if [ -d ${q(joined)} ]; then
${PLUGIN_INDEX_NAMES.map(
  (name) =>
    `  if [ -f ${q(posix.join(joined, name))} ]; then printf '%s\\n' ${q(posix.join(joined, name))}; exit 0; fi`
).join('\n')}
fi
exit 44`,
    signal,
    4096
  )
  if (result.code === 44) return undefined
  if (result.code !== 0 || result.truncated || result.terminationReason)
    throw new Error(`Cannot inspect project plugin tool entry: ${joined}`)
  const path = result.stdout.trim()
  if (!path || /[\0\r\n]/u.test(path))
    throw new Error(`Cannot inspect project plugin tool entry: ${joined}`)
  return path
}

function runtimeStates(value: unknown): ReadonlyMap<string, PluginRuntimeState> {
  if (value === undefined) return new Map()
  const root = object(value, 'plugin runtime configuration')
  const rawPlugins = root.plugins === undefined ? {} : object(root.plugins, 'plugin runtime states')
  const states = new Map<string, PluginRuntimeState>()
  for (const [name, raw] of Object.entries(rawPlugins)) {
    const state = object(raw, `runtime state for ${name}`)
    const enabledFeatures =
      state.enabledFeatures === null || state.enabledFeatures === undefined
        ? null
        : stringArray(state.enabledFeatures, `enabled features for ${name}`)
    states.set(name, { enabled: state.enabled === true, enabledFeatures })
  }
  return states
}

function overrides(value: unknown): ProjectPluginOverrides {
  if (value === undefined) return { disabled: new Set(), features: new Map() }
  const root = object(value, 'project plugin overrides')
  const disabled =
    root.disabled === undefined
      ? new Set<string>()
      : new Set(stringArray(root.disabled, 'disabled project plugins'))
  const features = new Map<string, readonly string[]>()
  if (root.features !== undefined) {
    for (const [name, selected] of Object.entries(object(root.features, 'project plugin features')))
      features.set(name, stringArray(selected, `project features for ${name}`))
  }
  return { disabled, features }
}

function toolEntries(
  manifest: JsonObject,
  enabledFeatures: readonly string[] | null,
  pluginName: string
): readonly string[] {
  const entries: string[] = []
  if (manifest.tools) {
    const base = Array.isArray(manifest.tools)
      ? stringArray(manifest.tools, `tools for ${pluginName}`)
      : typeof manifest.tools === 'string'
        ? [manifest.tools]
        : (() => {
            throw new Error(`Cannot inspect project plugins: invalid tools for ${pluginName}`)
          })()
    entries.push(...base)
  }
  if (manifest.features === undefined) return entries
  const features = object(manifest.features, `features for ${pluginName}`)
  const selected =
    enabledFeatures === null
      ? Object.entries(features)
          .filter(([, raw]) => object(raw, `feature for ${pluginName}`).default === true)
          .map(([name]) => name)
      : enabledFeatures
  for (const name of selected) {
    const raw = features[name]
    if (raw === undefined) continue
    const feature = object(raw, `feature ${name} for ${pluginName}`)
    if (feature.tools !== undefined)
      entries.push(...stringArray(feature.tools, `feature tools for ${pluginName}/${name}`))
  }
  return entries
}

async function loadProjectOverrides(
  host: WorkspaceHost,
  executionRoot: string,
  projectRoot: string,
  signal: AbortSignal
): Promise<ProjectPluginOverrides> {
  for (const directory of PROJECT_CONFIG_DIRS) {
    try {
      const value = await readJson(
        host,
        executionRoot,
        posix.join(projectRoot, directory, 'plugin-overrides.json'),
        signal
      )
      if (value !== undefined) return overrides(value)
    } catch {
      signal.throwIfAborted()
      // OMP warns and ignores malformed or unreadable project overrides.
    }
  }
  return overrides(undefined)
}

/** Refuse only enabled project plugins whose manifest resolves an importable tool module. */
export async function assertNoProjectPluginTools(options: {
  readonly host: WorkspaceHost
  readonly cwd: string
  readonly runtimeRoot: string
  readonly signal: AbortSignal
}): Promise<void> {
  const { host, cwd: projectRoot, runtimeRoot, signal } = options
  const pluginsRoot = await activeProjectPluginsRoot(host, runtimeRoot, projectRoot, signal)
  if (!pluginsRoot) return
  const packageValue = await readJson(
    host,
    runtimeRoot,
    posix.join(pluginsRoot, 'package.json'),
    signal
  )
  const lockValue = await readJson(
    host,
    runtimeRoot,
    posix.join(pluginsRoot, 'omp-plugins.lock.json'),
    signal
  )
  const dependencies =
    packageValue === undefined
      ? new Set<string>()
      : new Set(
          Object.keys(
            object(
              object(packageValue, 'project plugin package').dependencies ?? {},
              'dependencies'
            )
          )
        )
  const states = runtimeStates(lockValue)
  const names = new Set([...dependencies, ...states.keys()])
  const projectOverrides = await loadProjectOverrides(host, runtimeRoot, projectRoot, signal)
  for (const name of names) {
    if (!PACKAGE_NAME.test(name))
      throw new Error(
        `Cannot inspect project plugins: invalid package name ${JSON.stringify(name)}`
      )
    const pluginRoot = posix.join(pluginsRoot, 'node_modules', name)
    if (
      packageValue !== undefined &&
      !dependencies.has(name) &&
      !(await isSymlink(host, runtimeRoot, pluginRoot, signal))
    )
      continue
    const pluginValue = await readJson(
      host,
      runtimeRoot,
      posix.join(pluginRoot, 'package.json'),
      signal
    )
    if (pluginValue === undefined) continue
    const state = states.get(name)
    if (state?.enabled === false || projectOverrides.disabled.has(name)) continue
    const pluginPackage = object(pluginValue, `manifest for ${name}`)
    const rawManifest = pluginPackage.omp || pluginPackage.pi
    if (rawManifest === undefined) continue
    const manifest = object(rawManifest, `manifest for ${name}`)
    const enabledFeatures = projectOverrides.features.get(name) ?? state?.enabledFeatures ?? null
    for (const entry of toolEntries(manifest, enabledFeatures, name)) {
      const modulePath = await resolveToolModule(host, runtimeRoot, pluginRoot, entry, signal)
      if (modulePath)
        throw new Error(
          `Cannot start Phi RPC: project plugin tools are not allowed; plugin ${JSON.stringify(name)} resolves ${JSON.stringify(entry)} to ${JSON.stringify(modulePath)}. OMP imports project plugin tool modules before Phi guards can run.`
        )
    }
  }
}
