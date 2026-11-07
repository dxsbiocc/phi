/** The built-in generic agent. Phi shows each of its runs under a Greek-letter name of its own. */
export const GENERAL_AGENT_NAME = 'General'

/** Run names for General, in alphabet order. `Phi` is left out so a run never reads as the app. */
export const GENERAL_RUN_NAMES = [
  'Alpha',
  'Beta',
  'Gamma',
  'Delta',
  'Epsilon',
  'Zeta',
  'Eta',
  'Theta',
  'Iota',
  'Kappa',
  'Lambda',
  'Mu',
  'Nu',
  'Xi',
  'Omicron',
  'Pi',
  'Rho',
  'Sigma',
  'Tau',
  'Upsilon',
  'Chi',
  'Psi',
  'Omega'
] as const

const AGENT_TOOL_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/

/** Agent delegation tools are named after their agent: capitalised, e.g. `Wrapper`. */
export function isAgentToolName(toolName: unknown): toolName is string {
  return typeof toolName === 'string' && AGENT_TOOL_NAME_PATTERN.test(toolName)
}

/** Shown on a General card until Phi names the run: General is a template, not an agent. */
export const UNNAMED_AGENT_LABEL = 'Agent'

/** The name a delegation call is shown under until Phi names the run; undefined when it is not an agent. */
export function agentDisplayNameFromCall(toolName: unknown): string | undefined {
  if (!isAgentToolName(toolName)) return undefined
  return toolName === GENERAL_AGENT_NAME ? UNNAMED_AGENT_LABEL : toolName
}

/**
 * A random Greek-letter name for a new General run that no run in `taken` uses. Once every
 * letter is taken the letters repeat with a number (`Alpha 2`), lowest free number first.
 */
export function pickGeneralRunName(
  taken: Iterable<string>,
  random: () => number = Math.random
): string {
  const used = new Set(taken)
  for (let round = 1; ; round += 1) {
    const free = GENERAL_RUN_NAMES.map((letter) =>
      round === 1 ? letter : `${letter} ${round}`
    ).filter((name) => !used.has(name))
    if (free.length > 0) {
      const index = Math.min(free.length - 1, Math.floor(random() * free.length))
      return free[index]
    }
  }
}
