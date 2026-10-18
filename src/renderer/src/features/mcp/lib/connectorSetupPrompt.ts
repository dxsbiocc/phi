import { connectorCopy } from './connectorCopy'
import type { McpConnectorSetupProgress } from '../../../../../shared/mcpConnectorCatalog'

const MAX_PROMPT_BYTES = 8 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024
const ANSI_ESCAPE = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, 'gu')

export function buildConnectorSetupPrompt(setup: McpConnectorSetupProgress): string {
  const title = cleanText(setup.title ?? setup.id, 256)
  const summary = cleanText(setup.summary ?? setup.id, 1_024)
  const error = cleanText(setup.error ?? connectorCopy.unknownError, 1_024)
  const reason = setup.failureReason ? cleanText(setup.failureReason, 200) : undefined
  const detail = setup.detail ? utf8Tail(cleanText(setup.detail), MAX_OUTPUT_BYTES) : undefined
  const readmeUrl = setup.setupHint?.readmeUrl
    ? cleanText(setup.setupHint.readmeUrl, 500)
    : undefined
  const commands = setup.setupHint?.commands?.map((command) => cleanText(command, 200)) ?? []
  const intent =
    setup.failureKind === 'needs-setup' ? connectorCopy.setupIntent : connectorCopy.debugIntent

  const prompt = [
    connectorCopy.setupPromptTitle(intent, title),
    '',
    connectorCopy.setupPromptInstructions,
    '',
    connectorCopy.setupPromptSummary(summary),
    connectorCopy.setupPromptKind(setup.kind ?? 'local-stdio'),
    connectorCopy.setupPromptError(error),
    reason ? connectorCopy.setupPromptReason(reason) : undefined,
    detail ? connectorCopy.setupPromptOutput(detail) : undefined,
    readmeUrl ? connectorCopy.setupPromptReadme(readmeUrl) : undefined,
    commands.length ? connectorCopy.setupPromptCommands(commands) : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n')

  return utf8Head(prompt, MAX_PROMPT_BYTES)
}

function cleanText(value: string, maxCharacters = Number.POSITIVE_INFINITY): string {
  return stripControlCharacters(value.replace(ANSI_ESCAPE, ''))
    .replace(/\r\n?/gu, '\n')
    .slice(0, maxCharacters)
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code === 9 || code === 10 || code === 13 || (code > 31 && (code < 127 || code > 159))
    })
    .join('')
}

function utf8Head(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  return bytes.length <= maxBytes
    ? value
    : new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/u, '')
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  return bytes.length <= maxBytes
    ? value
    : new TextDecoder().decode(bytes.slice(bytes.length - maxBytes)).replace(/^\uFFFD/u, '')
}
