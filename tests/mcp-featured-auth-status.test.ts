import assert from 'node:assert/strict'
import test from 'node:test'
import {
  featuredAuthFailureNotice,
  featuredOAuthStatusFromError
} from '../src/renderer/src/features/mcp/lib/featuredAuthStatus'

test('an unfinished login timeout restores the signed-out state', () => {
  const message = 'Authorization timed out'
  assert.equal(
    featuredAuthFailureNotice(message),
    'Sign-in was not completed within two minutes, so authorization was cancelled. You can try again.'
  )
  assert.equal(featuredOAuthStatusFromError(message, 'Canva'), 'unauthenticated')
  assert.equal(
    featuredAuthFailureNotice('OAuth callback cancelled: 授权已超时'),
    featuredAuthFailureNotice(message)
  )
})

test('closing the authorization from Phi does not mark the connector unavailable', () => {
  const message = 'Authorization cancelled'
  assert.equal(featuredAuthFailureNotice(message), null)
  assert.equal(featuredOAuthStatusFromError(message, 'BioRender'), 'unauthenticated')
  assert.equal(featuredAuthFailureNotice('OAuth callback cancelled: 授权已取消'), null)
})
