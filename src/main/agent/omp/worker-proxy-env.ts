import { execFileSync } from 'node:child_process'
import { readLoginShellEnv, type LoginShellEnv } from './login-shell-env'

// bun reads proxies only from HTTP(S)_PROXY / NO_PROXY, never from the macOS
// system proxy. A terminal launch inherits those variables from the shell; a
// Finder/Dock launch does not, so every model request from the worker would go
// out directly (and fail behind a required proxy or in a blocked region).
// When nothing is inherited, the worker gets proxy variables from, in order:
//   1. the macOS system proxy (`scutil --proxy`, HTTP/HTTPS entries)
//   2. the user's login shell (what a terminal would have exported)

const PROXY_VARIABLES = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy'
] as const
const NO_PROXY_VARIABLES = ['NO_PROXY', 'no_proxy'] as const
// The worker reaches local services (bridges, kernels); never proxy loopback.
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1']
const SCUTIL_TIMEOUT_MS = 3000

export type ProxyEnv = Record<string, string>

export type WorkerProxyOptions = {
  platform?: NodeJS.Platform
  readSystemProxy?: () => string | undefined
  readLoginShell?: (env: NodeJS.ProcessEnv) => LoginShellEnv
}

function hasProxy(env: Partial<Record<string, string | undefined>>): boolean {
  return PROXY_VARIABLES.some((name) => Boolean(env[name]))
}

function noProxyValue(extraHosts: string[]): string {
  return [...new Set([...LOOPBACK_HOSTS, ...extraHosts])].join(',')
}

function withNoProxy(proxies: ProxyEnv, noProxy: string): ProxyEnv {
  return { ...proxies, NO_PROXY: noProxy, no_proxy: noProxy }
}

function readScutilProxy(): string | undefined {
  try {
    return execFileSync('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: SCUTIL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return undefined
  }
}

type ScutilProxy = { fields: Record<string, string>; exceptions: string[] }

function parseScutil(output: string): ScutilProxy {
  const fields: Record<string, string> = {}
  const exceptions: string[] = []
  let inExceptions = false
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('ExceptionsList :')) {
      inExceptions = true
      continue
    }
    if (inExceptions) {
      if (line === '}') inExceptions = false
      else {
        const item = /^\d+\s*:\s*(.+)$/.exec(line)
        if (item) exceptions.push(item[1])
      }
      continue
    }
    const field = /^(\w+)\s*:\s*(.+)$/.exec(line)
    if (field) fields[field[1]] = field[2]
  }
  return { fields, exceptions }
}

function noProxyHost(exception: string): string | undefined {
  // NO_PROXY has no CIDR syntax in bun/curl; `*.local` means `.local`.
  if (exception.includes('/')) return undefined
  return exception.startsWith('*.') ? exception.slice(1) : exception
}

/** Proxy variables from `scutil --proxy` output; undefined when no HTTP(S) proxy is on. */
export function proxyEnvFromScutil(output: string): ProxyEnv | undefined {
  const { fields, exceptions } = parseScutil(output)
  const endpoint = (kind: 'HTTP' | 'HTTPS'): string | undefined => {
    const host = fields[`${kind}Proxy`]
    if (fields[`${kind}Enable`] !== '1' || !host) return undefined
    const port = fields[`${kind}Port`]
    return `http://${host}${port ? `:${port}` : ''}`
  }
  const https = endpoint('HTTPS')
  const http = endpoint('HTTP')
  if (!https && !http) return undefined

  const proxies: ProxyEnv = {}
  if (https) Object.assign(proxies, { HTTPS_PROXY: https, https_proxy: https })
  if (http) Object.assign(proxies, { HTTP_PROXY: http, http_proxy: http })
  const extraHosts = exceptions.map(noProxyHost).filter((host): host is string => Boolean(host))
  return withNoProxy(proxies, noProxyValue(extraHosts))
}

function proxyEnvFromLoginShell(shellEnv: LoginShellEnv): ProxyEnv | undefined {
  if (!hasProxy(shellEnv)) return undefined
  const proxies: ProxyEnv = {}
  for (const name of PROXY_VARIABLES) {
    const value = shellEnv[name]
    if (value) proxies[name] = value
  }
  const shellNoProxy = NO_PROXY_VARIABLES.map((name) => shellEnv[name]).find(Boolean)
  const extraHosts = shellNoProxy ? shellNoProxy.split(',').map((host) => host.trim()) : []
  return withNoProxy(proxies, noProxyValue(extraHosts.filter(Boolean)))
}

/**
 * Proxy variables to add to the worker's environment. Empty when the app
 * already inherited a proxy (terminal launch) or none is configured anywhere.
 */
export function resolveWorkerProxyEnv(
  env: NodeJS.ProcessEnv,
  options: WorkerProxyOptions = {}
): ProxyEnv {
  if (hasProxy(env)) return {}
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return {}

  const scutil = platform === 'darwin' ? (options.readSystemProxy ?? readScutilProxy)() : undefined
  const found =
    (scutil ? proxyEnvFromScutil(scutil) : undefined) ??
    proxyEnvFromLoginShell((options.readLoginShell ?? readLoginShellEnv)(env))
  if (!found) return {}

  // Keep hosts the app was already told to bypass.
  const inheritedNoProxy = NO_PROXY_VARIABLES.map((name) => env[name]).find(Boolean)
  if (!inheritedNoProxy) return found
  const hosts = [...found.NO_PROXY.split(','), ...inheritedNoProxy.split(',').map((h) => h.trim())]
  return withNoProxy(found, noProxyValue(hosts.filter(Boolean)))
}
