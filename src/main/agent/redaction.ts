const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g
const ACCOUNT_KEY_FRAGMENT = /\borg-[A-Za-z0-9_-]+(?:<[^>\s]+>)?/g
const API_KEY_FRAGMENT = /\bak-[A-Za-z0-9_-]{8,}\b/g
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi
const KEY_VALUE_SECRET = /\b(api[-_]?key|token|secret|password)(\s*[:=]\s*)(["']?)[^\s"',;)]+/gi

export function redactSensitiveText(text: string): string {
  return text
    .replace(OPENAI_STYLE_KEY, '[redacted]')
    .replace(ACCOUNT_KEY_FRAGMENT, '[redacted]')
    .replace(API_KEY_FRAGMENT, '[redacted]')
    .replace(BEARER_TOKEN, '$1[redacted]')
    .replace(KEY_VALUE_SECRET, '$1$2$3[redacted]')
}

export function isSecretMetadataKey(key: string): boolean {
  return /^(secret|token|password|api[-_]?key)$/i.test(key)
}
