import assert from 'node:assert/strict'
import test from 'node:test'
import {
  featuredAuthFailureNotice,
  featuredOAuthStatusFromError
} from '../src/renderer/src/features/mcp/lib/featuredAuthStatus'

test('an unfinished login timeout restores the signed-out state', () => {
  const message = 'OAuth callback cancelled: 授权已超时'
  assert.equal(
    featuredAuthFailureNotice(message),
    '两分钟内没有完成登录，授权已自动取消。可以重新授权。'
  )
  assert.equal(featuredOAuthStatusFromError(message, 'Canva'), 'unauthenticated')
})

test('closing the authorization from Phi does not mark the connector unavailable', () => {
  const message = 'OAuth callback cancelled: 授权已取消'
  assert.equal(featuredAuthFailureNotice(message), null)
  assert.equal(featuredOAuthStatusFromError(message, 'BioRender'), 'unauthenticated')
})
