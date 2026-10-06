import { execFileSync } from 'node:child_process'

// Apps launched from Finder/Dock do not see what the user's shell rc files
// export (PATH additions, proxy variables). This reads those variables from an
// interactive login shell, the way a terminal session would get them.

export const LOGIN_SHELL_VARIABLES = [
  'PATH',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy'
] as const

export type LoginShellVariable = (typeof LOGIN_SHELL_VARIABLES)[number]
export type LoginShellEnv = Partial<Record<LoginShellVariable, string>>

const LOGIN_SHELL_TIMEOUT_MS = 5000
const VALUE_MARKER = '__PHI_ENV__'

const cache = new Map<string, LoginShellEnv>()

/** Non-empty login-shell values; one shell launch per shell, cached. */
export function readLoginShellEnv(env: NodeJS.ProcessEnv): LoginShellEnv {
  const shell = env.SHELL || '/bin/zsh'
  const hit = cache.get(shell)
  if (hit) return hit

  const values: LoginShellEnv = {}
  try {
    // -i -l so rc files run; markers fence each value off from rc-file noise.
    const script = LOGIN_SHELL_VARIABLES.map(
      (name) => `printf '%s%s%s' '${VALUE_MARKER}' "$${name}" '${VALUE_MARKER}'`
    ).join('; ')
    const output = execFileSync(shell, ['-ilc', script], {
      encoding: 'utf8',
      timeout: LOGIN_SHELL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const parts = output.split(VALUE_MARKER)
    LOGIN_SHELL_VARIABLES.forEach((name, index) => {
      const value = parts[index * 2 + 1]
      if (value) values[name] = value
    })
  } catch {
    // No usable login shell: callers fall back to their other sources.
  }
  cache.set(shell, values)
  return values
}

export function clearLoginShellEnvCache(): void {
  cache.clear()
}
