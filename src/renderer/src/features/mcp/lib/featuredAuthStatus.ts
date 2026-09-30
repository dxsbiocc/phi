export function isFeaturedAuthTimeout(message: string): boolean {
  return message.includes('授权已超时') || message.includes('aborted due to timeout')
}

export function isFeaturedAuthCancellation(message: string): boolean {
  return (
    isFeaturedAuthTimeout(message) ||
    message.includes('授权已取消') ||
    message.includes('OAuth callback cancelled') ||
    message.includes('LoginCancelled')
  )
}

/** Null means the attempt ended without an error to show. */
export function featuredAuthFailureNotice(message: string): string | null {
  if (isFeaturedAuthTimeout(message)) {
    return '两分钟内没有完成登录，授权已自动取消。可以重新授权。'
  }
  if (isFeaturedAuthCancellation(message)) return null
  if (/No handler registered for ['"]mcp:authorizeFeatured['"]/.test(message)) {
    return '主进程尚未加载授权接口，请重启 Phi 后重试'
  }
  return message
}

/** A missing login is a retryable signed-out state, not a broken connector. */
export function featuredOAuthStatusFromError(
  message: string,
  connectorName: string
): 'unauthenticated' | 'unavailable' {
  if (
    isFeaturedAuthCancellation(message) ||
    message.includes(`请先授权登录 ${connectorName}`) ||
    message.includes('尚不支持登录状态查询') ||
    message.includes('尚不支持 OAuth')
  ) {
    return 'unauthenticated'
  }
  return 'unavailable'
}
