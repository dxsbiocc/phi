export type LocalConnectorFailureClassification =
  | { kind: 'needs-setup'; reason: string }
  | {
      kind: 'generic'
      reason?: never
    }

const SETUP_PATTERNS = [
  /\bconfig(?:uration)?(?:\s+file)?\b.{0,160}\b(?:not found|missing|does not exist|cannot be found)\b/iu,
  /\bnot\s+(?:yet\s+)?(?:configured|initiali[sz]ed|set\s*up)\b/iu,
  /\brun\b.{0,160}\b(?:init|setup|login|configure|config|auth|authenticate)\b/iu,
  /\b(?:missing|required)\b.{0,80}\b(?:credentials?|api[_ -]?keys?|tokens?|passwords?|secrets?|env(?:ironment)?\s+variables?)\b/iu,
  /\b(?:api[_ -]?keys?|tokens?|credentials?)\s+(?:is\s+|are\s+)?(?:required|not set|missing|empty)\b/iu,
  /\bENOENT\b.{0,200}(?:\.toml\b|\.json\b|\.ya?ml\b|\.env\b|\bconfig(?:uration)?\b)/iu,
  /\bplease\s+(?:log\s*in|login|authenticate|configure)\b/iu,
  /\b(?:authentication required|login required|unauthori[sz]ed)\b/iu
] as const

export function classifyLocalConnectorFailure(input: {
  error?: string
  detail?: string
}): LocalConnectorFailureClassification {
  if (!input.detail) return { kind: 'generic' }
  for (const rawLine of input.detail.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (
      !line ||
      /^\d+\s*\|/u.test(line) ||
      isStackFrame(line) ||
      !SETUP_PATTERNS.some((pattern) => pattern.test(line))
    ) {
      continue
    }
    return { kind: 'needs-setup', reason: line.slice(0, 200) }
  }
  return { kind: 'generic' }
}

/** `at fn (file:1:2)`, `at file:1:2`, and Firefox/Bun style `fn@file:1:2` frames mention paths, not setup. */
function isStackFrame(line: string): boolean {
  return /^at\s/u.test(line) || /^[^\s@]*@\S+:\d+:\d+$/u.test(line)
}
