import { GENERAL_RUN_NAMES } from './agentDisplayName'

type GeneralRunName = (typeof GENERAL_RUN_NAMES)[number]

const GREEK_SYMBOL_BY_RUN_NAME = {
  Alpha: 'α',
  Beta: 'β',
  Gamma: 'γ',
  Delta: 'δ',
  Epsilon: 'ε',
  Zeta: 'ζ',
  Eta: 'η',
  Theta: 'θ',
  Iota: 'ι',
  Kappa: 'κ',
  Lambda: 'λ',
  Mu: 'μ',
  Nu: 'ν',
  Xi: 'ξ',
  Omicron: 'ο',
  Pi: 'π',
  Rho: 'ρ',
  Sigma: 'σ',
  Tau: 'τ',
  Upsilon: 'υ',
  Chi: 'χ',
  Psi: 'ψ',
  Omega: 'ω'
} as const satisfies Record<GeneralRunName, string>

const GENERAL_RUN_NAME_PATTERN = /^([A-Z][a-z]+)(?: ((?:[2-9]|[1-9]\d+)))?$/

/** Converts a generated General run name to the compact symbol used in user-facing copy. */
export function greekSymbolForRunName(name: string): string | undefined {
  const match = GENERAL_RUN_NAME_PATTERN.exec(name)
  if (!match) return undefined
  const baseName = match[1]
  if (!(baseName in GREEK_SYMBOL_BY_RUN_NAME)) return undefined
  const symbol = GREEK_SYMBOL_BY_RUN_NAME[baseName as GeneralRunName]
  return `${symbol}${match[2] ?? ''}`
}
