import { redactSensitiveText } from '../../src/main/agent/redaction'

const DIAGNOSTIC_TEXT_LIMIT = 500

/** Bounded, failure-log-safe text for the Windows Notebook smoke. */
export function safeDiagnosticText(value: unknown, maxLength = DIAGNOSTIC_TEXT_LIMIT): string {
  const redacted = String(value)
    // Keep query values out entirely, then reuse the app-wide secret redaction.
    .replace(/([?&](?:token|access_token|api_key|api-key|key)=)[^\s&'"]+/gi, '$1<redacted>')
    .replace(/\b(authorization|cookie)\s*[:=][^\r\n]*/gi, '$1=<redacted>')
  return redactSensitiveText(redacted).slice(0, maxLength)
}
