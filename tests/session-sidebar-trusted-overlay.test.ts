import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createTrustedDialogRequestCoordinator } from '../src/renderer/src/lib/trustedOverlayRequests'

test('session sidebar delete dialogs wait for trusted publication and ignore failed hides', () => {
  const queued = new Map<string, { publish: () => void; cancel: () => void }>()
  const cancelled: string[] = []
  let visibleDialog: 'session' | 'project' | null = null
  const coordinator = createTrustedDialogRequestCoordinator({
    request: (key, publish, onCancel) => {
      queued.set(key, { publish, cancel: onCancel })
    },
    cancel: (key) => cancelled.push(key)
  })

  coordinator.request('session-delete', () => {
    visibleDialog = 'session'
  })
  coordinator.request('project-delete', () => {
    visibleDialog = 'project'
  })
  assert.equal(visibleDialog, null)

  const sessionRequest = queued.get('session-delete')
  assert.ok(sessionRequest)
  sessionRequest.cancel()
  sessionRequest.publish()
  assert.equal(visibleDialog, null)

  const projectRequest = queued.get('project-delete')
  assert.ok(projectRequest)
  projectRequest.publish()
  assert.equal(visibleDialog, 'project')

  coordinator.request('session-delete', () => {
    visibleDialog = 'session'
  })
  coordinator.dispose()
  queued.get('session-delete')?.publish()
  assert.equal(visibleDialog, 'project')
  assert.deepEqual(cancelled, ['session-delete'])
})

test('expanded session sidebar routes destructive confirmations through the app gate', () => {
  const sidebarSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/SessionSidebar.tsx'),
    'utf8'
  )
  const appSidebarSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/AppWorkspaceSidebar.tsx'),
    'utf8'
  )
  assert.match(
    sidebarSource,
    /onDeleteProject=\{\(\) => \{[\s\S]{0,180}trustedDialogs\.request\(PROJECT_DELETE_OVERLAY_KEY/
  )
  assert.match(
    sidebarSource,
    /onDelete=\{\(\) => \{[\s\S]{0,180}trustedDialogs\.request\(SESSION_DELETE_OVERLAY_KEY/
  )
  assert.match(appSidebarSource, /requestTrustedOverlay=\{requestTrustedOverlay\}/)
  assert.match(appSidebarSource, /cancelTrustedOverlay=\{cancelTrustedOverlay\}/)
})
