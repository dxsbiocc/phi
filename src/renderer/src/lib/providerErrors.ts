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
  const rawMessage = redactProviderErrorMessage(message.trim() || '请求失败')

  if (rawMessage.startsWith('AI 没有生成可插入内容')) {
    return {
      title: '没有可插入的 notebook cell',
      description: '模型返回内容未能转换成 notebook cell。请查看原始返回片段后重试。',
      rawMessage,
      showRawMessage: true,
      action: null
    }
  }

  if (isProviderBillingError(rawMessage)) {
    return {
      title: '账户余额不足',
      description: '检测到 API 账户余额不足或欠费。请到对应 Provider 控制台充值或检查账单后重试。',
      rawMessage,
      showRawMessage: false,
      action: null
    }
  }

  if (matchesAnyPattern(rawMessage, RATE_LIMIT_PATTERNS)) {
    return {
      title: '请求太频繁',
      description:
        'Provider 当前触发了速率限制。请稍等片刻后重试，或切换到限额更高的模型/API 账户。',
      rawMessage,
      showRawMessage: true,
      action: null
    }
  }

  if (matchesAnyPattern(rawMessage, AUTHENTICATION_PATTERNS)) {
    return {
      title: 'API Key 无效或认证失败',
      description:
        'Provider 返回认证失败。请重新配置对应 Provider 的 API Key，并确认使用的是该 Provider 的模型调用凭据。',
      rawMessage,
      showRawMessage: true,
      action: 'providerSettings',
      actionLabel: '去配置 Provider'
    }
  }

  if (matchesAnyPattern(rawMessage, CONFIGURATION_PATTERNS)) {
    return {
      title: 'Provider 配置需要处理',
      description: '当前请求没有可用的 Provider、模型或凭据。请检查 Provider 配置后重试。',
      rawMessage,
      showRawMessage: true,
      action: 'providerSettings',
      actionLabel: '去配置 Provider'
    }
  }

  return {
    title: '请求失败',
    description: '模型请求没有完成，请根据原始错误信息处理后重试。',
    rawMessage,
    showRawMessage: true,
    action: null
  }
}
