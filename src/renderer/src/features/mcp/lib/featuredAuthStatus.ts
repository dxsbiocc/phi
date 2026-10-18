import { connectorCopy } from './connectorCopy'
export function isFeaturedAuthTimeout(message: string): boolean {
  return (
    message.includes('Authorization timed out') ||
    message.includes('授权已超时') ||
    message.includes('aborted due to timeout')
  )
}

export function isFeaturedAuthCancellation(message: string): boolean {
  return (
    isFeaturedAuthTimeout(message) ||
    message.includes('Authorization cancelled') ||
    message.includes('授权已取消') ||
    message.includes('OAuth callback cancelled') ||
    message.includes('LoginCancelled')
  )
}

/** Null means the attempt ended without an error to show. */
export function featuredAuthFailureNotice(message: string): string | null {
  if (isFeaturedAuthTimeout(message)) {
    return connectorCopy.authTimeout
  }
  if (isFeaturedAuthCancellation(message)) return null
  if (/No handler registered for ['"]mcp:authorizeFeatured['"]/.test(message)) {
    return connectorCopy.authBackendMissing
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
    message.includes(`Sign in to ${connectorName} first`) ||
    message.includes('does not support sign-in status checks') ||
    message.includes('does not support OAuth authorization') ||
    message.includes(`请先授权登录 ${connectorName}`) ||
    message.includes('尚不支持登录状态查询') ||
    message.includes('尚不支持 OAuth')
  ) {
    return 'unauthenticated'
  }
  return 'unavailable'
}
