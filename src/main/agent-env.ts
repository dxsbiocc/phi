import { getDefaultPhiAgentDir } from './agent/runtime-paths'

export const DEFAULT_MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1'

export function applyPhiAgentEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  env.PI_CODING_AGENT_DIR = getDefaultPhiAgentDir()
  env.MOONSHOT_BASE_URL ??= DEFAULT_MOONSHOT_BASE_URL
}

// Must be imported first, before any module that constructs an agent runtime
// object (AuthManager, session-manager) at its own module top level — ESM
// import evaluation runs those top-level side effects before the importing
// file's own body, so setting this env var later in index.ts is too late.
//
// Phi owns its own config directory rather than sharing a runtime CLI's default
// home — concurrent writes to the same auth/session stores from two
// independent tools caused lock contention and flaky credential state.
// PI_CODING_AGENT_DIR is still the runtime's official override and redirects
// auth, models, sessions, settings, plugin state, and resource discovery in one go.
//
// Kimi/Moonshot's catalog still defaults to the older .ai host unless
// MOONSHOT_BASE_URL is provided. Phi's internal beta is local-first for China
// users, so set the current Open Platform host while preserving explicit user
// overrides.
applyPhiAgentEnvironment()
