import { providerErrorCopy } from './providerErrorCopy'

export type ProviderErrorAction = 'providerSettings' | null

export interface ProviderErrorDisplay {
  title: string
  description: string
  rawMessage: string
  showRawMessage: boolean
  action: ProviderErrorAction
  actionLabel?: string
}

const SENSITIVE_ERROR_PATTERNS = [
  /\borg-[A-Za-z0-9_-]+(?:<[^>\s]+>)?/g,
  /\bak-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[-_]?key|token|secret|password)(\s*[:=]\s*)(["']?)[^\s"',;)]+/gi
]

const BILLING_PATTERNS = [
  /\b402\b/i,
  /insufficient[\s_-]*(balance|quota|credits?)/i,
  /quota[_\s-]*exceeded/i,
  /\bbilling\b/i,
  /余额不足/,
  /欠费/,
  /充值/
]

const RATE_LIMIT_PATTERNS = [
  /\b429\b/i,
  /rate[_\s-]*limit/i,
  /too many requests/i,
  /max\s+rpm/i,
  /retry-after/i,
  /请求.*(过于频繁|太频繁|限流)/
]

const AUTHENTICATION_PATTERNS = [
  /\b401\b/i,
  /unauthorized/i,
  /invalid[\s_-]*authentication/i,
  /authentication[\s_-]*error/i,
  /invalid[\s_-]*(api[\s_-]*)?key/i
]

const CONFIGURATION_PATTERNS = [
  /provider/i,
  /api[\s_-]*key/i,
  /resource[_\s-]*not[_\s-]*found/i,
  /not\s+found\s+the\s+model/i,
  /model\s+not\s+found/i,
  /permission\s+denied/i,
  /未配置/,
  /没有配置/,
  /模型不可用/,
  /模型.*不可用/,
  /模型.*不存在/,
  /权限.*拒绝/,
  /无可用模型/
]

function matchesAnyPattern(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message))
}

export function redactProviderErrorMessage(message: string): string {
  return SENSITIVE_ERROR_PATTERNS.reduce((current, pattern) => {
    if (pattern.source.includes('api')) {
      return current.replace(pattern, '$1$2$3[redacted]')
    }
    if (pattern.source.includes('Bearer')) {
      return current.replace(pattern, '$1[redacted]')
    }
    return current.replace(pattern, '[redacted]')
  }, message)
}

export function isProviderBillingError(message: string): boolean {
  return matchesAnyPattern(message, BILLING_PATTERNS)
}

export function getProviderErrorDisplay(message: string): ProviderErrorDisplay {
  const rawMessage = redactProviderErrorMessage(message.trim() || providerErrorCopy.requestFailed)

  if (rawMessage.startsWith('AI 没有生成可插入内容')) {
    return {
      title: providerErrorCopy.notebookEmptyTitle,
      description: providerErrorCopy.notebookEmptyBody,
      rawMessage,
      showRawMessage: true,
      action: null
    }
  }

  if (
    /ERROR_RATE_LIMITED_CHANGEABLE/i.test(rawMessage) &&
    /["']?isRetryable["']?\s*[:=]\s*false/i.test(rawMessage)
  ) {
    return {
      title: providerErrorCopy.cursorLimitTitle,
      description: providerErrorCopy.cursorLimitBody,
      rawMessage,
      showRawMessage: false,
      action: null
    }
  }

  if (isProviderBillingError(rawMessage)) {
    return {
      title: providerErrorCopy.billingTitle,
      description: providerErrorCopy.billingBody,
      rawMessage,
      showRawMessage: false,
      action: null
    }
  }

  if (matchesAnyPattern(rawMessage, RATE_LIMIT_PATTERNS)) {
    return {
      title: providerErrorCopy.rateLimitTitle,
      description: providerErrorCopy.rateLimitBody,
      rawMessage,
      showRawMessage: true,
      action: null
    }
  }

  if (matchesAnyPattern(rawMessage, AUTHENTICATION_PATTERNS)) {
    return {
      title: providerErrorCopy.authenticationTitle,
      description: providerErrorCopy.authenticationBody,
      rawMessage,
      showRawMessage: true,
      action: 'providerSettings',
      actionLabel: providerErrorCopy.configureProvider
    }
  }

  if (/Cursor run transport could not negotiate HTTP\/2|h2 is not supported/i.test(rawMessage)) {
    return {
      title: providerErrorCopy.cursorTransportTitle,
      description: providerErrorCopy.cursorTransportBody,
      rawMessage,
      showRawMessage: false,
      action: null
    }
  }

  if (matchesAnyPattern(rawMessage, CONFIGURATION_PATTERNS)) {
    return {
      title: providerErrorCopy.configurationTitle,
      description: providerErrorCopy.configurationBody,
      rawMessage,
      showRawMessage: true,
      action: 'providerSettings',
      actionLabel: providerErrorCopy.configureProvider
    }
  }

  return {
    title: providerErrorCopy.requestFailed,
    description: providerErrorCopy.requestFailedBody,
    rawMessage,
    showRawMessage: true,
    action: null
  }
}
