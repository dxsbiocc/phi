import assert from 'node:assert/strict'

/**
 * The real remote workspace boundary rejects any key besides sessionId/projectId
 * ("远程工作区请求只能包含会话、项目、路径和操作类型"). Fakes of the boundary must be just as strict,
 * otherwise a caller that forwards its whole context passes tests and fails in the app.
 */
export function assertBoundaryIdentity(input: unknown): void {
  assert.ok(typeof input === 'object' && input !== null, 'boundary input must be an object')
  assert.deepEqual(
    Object.keys(input as Record<string, unknown>).sort(),
    ['projectId', 'sessionId'],
    'boundary input must contain only sessionId and projectId'
  )
}
