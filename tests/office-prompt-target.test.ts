import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { sanitizeOfficeTargetInput } from '../src/shared/officeProtocol'
import {
  captureOfficeTarget,
  retargetCapturedOfficePrompt,
  visibleOfficeComposerTarget,
  withCapturedOfficeTarget
} from '../src/renderer/src/features/office/lib/officePromptTarget'
import { OfficeDocumentRegistry } from '../src/renderer/src/features/office/lib/officeDocumentRegistry'
import { sanitizePromptTargetForIpc } from '../src/preload/promptTarget'
import {
  bindOfficePromptTarget,
  prepareOfficePromptSubmission
} from '../src/main/agent/office/office-prompt-target'
import { officePromptFailureRecovery } from '../src/renderer/src/features/office/lib/officePromptFailure'
import { OfficeTargetChip } from '../src/renderer/src/features/office/components/OfficeTargetChip'

test('Office prompt targets keep only the renderer-owned artifact id', () => {
  assert.deepEqual(
    sanitizeOfficeTargetInput({
      artifactId: 'artifact-1',
      sessionId: 'forged-session',
      projectId: 'forged-project',
      runId: 'forged-run'
    }),
    { artifactId: 'artifact-1' }
  )
})

test('Office prompt targets keep only selection intent and ignore forged selection contents', () => {
  assert.deepEqual(
    sanitizeOfficeTargetInput({
      artifactId: 'artifact-1',
      includeSelection: true,
      sheet: 'Forged',
      range: 'A1:XFD1048576',
      paths: ['/Forged/A1']
    }),
    { artifactId: 'artifact-1', includeSelection: true }
  )
})

test('the Office association chip remove control cancels the current association', () => {
  let removed = false
  const chip = OfficeTargetChip({
    target: { artifactId: 'artifact-1', label: '预算.xlsx' },
    onRemove: () => {
      removed = true
    }
  })
  const children = chip.props.children as Array<{ props: { onClick?: () => void } }>
  children.find((child) => child?.props.onClick)?.props.onClick?.()

  assert.equal(removed, true)
})

test('the Office association chip exposes a separate clear-selection action', () => {
  let cleared = false
  let removed = false
  const chip = OfficeTargetChip({
    target: {
      artifactId: 'artifact-1',
      label: '预算.xlsx',
      selection: { sheet: 'Sheet1', range: 'A1:B3', paths: ['/Sheet1/A1'] }
    },
    onClearSelection: () => {
      cleared = true
    },
    onRemove: () => {
      removed = true
    }
  })
  const children = chip.props.children as Array<{ props: { onClick?: () => void } }>
  children[1]?.props.onClick?.()

  assert.equal(cleared, true)
  assert.equal(removed, false)
})

test('a DOCX association never exposes a spreadsheet selection', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeTargetChip, {
      target: {
        artifactId: 'artifact-docx',
        label: '说明.docx',
        humanEdit: 'none',
        selection: { sheet: 'Sheet1', range: 'A1:B3', paths: ['/Sheet1/A1'] }
      },
      onClearSelection: () => undefined,
      onRemove: () => undefined
    })
  )

  assert.match(markup, /关联文档：说明\.docx/u)
  assert.doesNotMatch(markup, /选区/u)
  assert.doesNotMatch(markup, /data-phi-office-clear-selection/u)
})

test('a dismissed document stays untargeted until another ready document becomes active', () => {
  const first = { artifactId: 'artifact-1', label: '预算.xlsx' }
  const second = { artifactId: 'artifact-2', label: '计划.xlsx' }

  assert.equal(visibleOfficeComposerTarget(first, 'artifact-1'), null)
  assert.deepEqual(visibleOfficeComposerTarget(second, 'artifact-1'), second)
  assert.equal(captureOfficeTarget(visibleOfficeComposerTarget(first, 'artifact-1')), undefined)
  assert.deepEqual(captureOfficeTarget(visibleOfficeComposerTarget(second, 'artifact-1')), {
    artifactId: 'artifact-2'
  })
})

test('materializing a new chat keeps each queued prompt Office target', () => {
  assert.deepEqual(
    retargetCapturedOfficePrompt(
      {
        path: null,
        cwd: '/workspace',
        sessionGeneration: 1,
        officeTarget: { artifactId: 'artifact-1' }
      },
      {
        path: 'phi-session://session-1',
        phiSessionId: 'session-1',
        cwd: '/workspace',
        sessionGeneration: 2
      }
    ),
    {
      path: 'phi-session://session-1',
      phiSessionId: 'session-1',
      cwd: '/workspace',
      sessionGeneration: 2,
      officeTarget: { artifactId: 'artifact-1' }
    }
  )
})

test('a rejected Office target preserves the composer draft and readable error', () => {
  assert.deepEqual(
    officePromptFailureRecovery(
      {
        ok: false,
        error: {
          code: 'target_not_found',
          message: '关联的 Office 文档已不存在或已关闭'
        }
      },
      '请更新预算'
    ),
    {
      draft: '请更新预算',
      error: {
        code: 'target_not_found',
        message: '关联的 Office 文档已不存在或已关闭'
      }
    }
  )
})

test('a rejected Office selection preserves the composer draft and readable error', () => {
  assert.deepEqual(
    officePromptFailureRecovery(
      {
        ok: false,
        error: {
          code: 'selection_unavailable',
          message: '无法读取当前选区，请重新选择或清除选区'
        }
      },
      '请汇总选区'
    ),
    {
      draft: '请汇总选区',
      error: {
        code: 'selection_unavailable',
        message: '无法读取当前选区，请重新选择或清除选区'
      }
    }
  )
})

test('the prompt gate returns a structured session mismatch before submission', async () => {
  let accepted = false
  const failure = await bindOfficePromptTarget(
    { artifactId: 'artifact-1' },
    { runId: 'run-1', sessionId: 'session-2', projectId: 'project-2' },
    {
      bindPromptTarget: async () => {
        accepted = true
        throw Object.assign(new Error('关联的 Office 文档不属于当前会话'), {
          code: 'target_session_mismatch'
        })
      }
    }
  )

  assert.equal(accepted, true)
  assert.deepEqual(failure, {
    ok: false,
    error: {
      code: 'target_session_mismatch',
      message: '关联的 Office 文档不属于当前会话'
    }
  })
})

test('the prompt gate rejects a missing target instead of submitting without one', async () => {
  const failure = await bindOfficePromptTarget(
    { artifactId: 'artifact-missing' },
    { runId: 'run-1', sessionId: 'session-1', projectId: null },
    {
      bindPromptTarget: async () => {
        throw Object.assign(new Error('关联的 Office 文档已不存在或已关闭'), {
          code: 'target_not_found'
        })
      }
    }
  )

  assert.deepEqual(failure, {
    ok: false,
    error: {
      code: 'target_not_found',
      message: '关联的 Office 文档已不存在或已关闭'
    }
  })
})

test('the submission gate never accepts a rejected Office target into message persistence or queueing', async () => {
  let accepted = false
  const result = await prepareOfficePromptSubmission(
    { artifactId: 'artifact-foreign' },
    { runId: 'run-1', sessionId: 'session-1', projectId: null },
    {
      bindPromptTarget: async () => {
        throw Object.assign(new Error('关联的 Office 文档不属于当前会话'), {
          code: 'target_session_mismatch'
        })
      }
    },
    () => {
      accepted = true
      return 'queued'
    }
  )

  assert.equal(accepted, false)
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'target_session_mismatch',
      message: '关联的 Office 文档不属于当前会话'
    }
  })
})

test('the submission gate binds host identity before accepting a valid message', async () => {
  let binding: unknown
  let includeSelection: boolean | undefined
  const result = await prepareOfficePromptSubmission(
    { artifactId: 'artifact-1', includeSelection: true },
    { runId: 'run-host', sessionId: 'session-host', projectId: 'project-host' },
    {
      bindPromptTarget: async (target, include) => {
        binding = target
        includeSelection = include
      }
    },
    () => 'queued'
  )

  assert.deepEqual(binding, {
    runId: 'run-host',
    artifactId: 'artifact-1',
    sessionId: 'session-host',
    projectId: 'project-host'
  })
  assert.equal(includeSelection, true)
  assert.deepEqual(result, { ok: true, value: 'queued' })
})

test('selection resolution failure rejects submission and preserves the message gate', async () => {
  let accepted = false
  const result = await prepareOfficePromptSubmission(
    { artifactId: 'artifact-1', includeSelection: true },
    { runId: 'run-selection', sessionId: 'session-1', projectId: null },
    {
      bindPromptTarget: async () => {
        throw Object.assign(new Error('无法读取当前选区，请重新选择或清除选区'), {
          code: 'selection_unavailable'
        })
      }
    },
    () => {
      accepted = true
      return 'queued'
    }
  )

  assert.equal(accepted, false)
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'selection_unavailable',
      message: '无法读取当前选区，请重新选择或清除选区'
    }
  })
})

test('preload strips host-owned identity fields from an Office prompt target', () => {
  assert.deepEqual(
    sanitizePromptTargetForIpc({
      path: null,
      cwd: '/workspace',
      sessionGeneration: 1,
      officeTarget: {
        artifactId: 'artifact-1',
        includeSelection: true,
        range: 'A1:XFD1048576',
        sessionId: 'forged-session',
        projectId: 'forged-project',
        runId: 'forged-run'
      }
    }),
    {
      path: null,
      cwd: '/workspace',
      sessionGeneration: 1,
      officeTarget: { artifactId: 'artifact-1', includeSelection: true }
    }
  )
})

test('the disabled Office development path leaves the original prompt payload untouched', () => {
  const prompt = { path: null, cwd: '/workspace', sessionGeneration: 1 }

  assert.equal(
    withCapturedOfficeTarget(prompt, { artifactId: 'artifact-1', label: '预算.xlsx' }, false),
    prompt
  )
})

test('the composer target follows ready Office documents and clears with the active panel', () => {
  const registry = new OfficeDocumentRegistry()
  registry.publish({
    state: 'ready',
    document: {
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: null,
      sourcePath: '/drafts/预算.xlsx',
      sourceHash: null,
      previewUrl: 'http://127.0.0.1:42001/'
    }
  })

  assert.deepEqual(registry.target('/drafts/预算.xlsx', '预算.xlsx'), {
    artifactId: 'artifact-1',
    label: '预算.xlsx'
  })
  assert.equal(registry.target('/drafts/计划.xlsx', '计划.xlsx'), null)

  registry.clear('/drafts/预算.xlsx', 'artifact-1')
  assert.equal(registry.target('/drafts/预算.xlsx', '预算.xlsx'), null)
})

test('the document registry applies immutable selection updates only to the current artifact', () => {
  const registry = new OfficeDocumentRegistry()
  const sourcePath = '/drafts/预算.xlsx'
  registry.publish({
    state: 'ready',
    document: {
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: null,
      sourcePath,
      sourceHash: null,
      previewUrl: 'http://127.0.0.1:42001/'
    }
  })
  const selection = { sheet: 'Sheet1', range: 'A1:B3', paths: ['/Sheet1/A1'] }
  registry.publishSelection('artifact-1', selection)
  selection.paths[0] = '/Sheet1/Z99'

  assert.deepEqual(registry.target(sourcePath, '预算.xlsx')?.selection, {
    sheet: 'Sheet1',
    range: 'A1:B3',
    paths: ['/Sheet1/A1']
  })
  assert.equal(registry.activeSheet(sourcePath), 'Sheet1')
  registry.publishSelection('artifact-1', { paths: ['/Sheet1/A1', '/Sheet2/A1'] })
  assert.equal(registry.activeSheet(sourcePath), undefined)

  registry.publish({
    state: 'ready',
    document: {
      artifactId: 'artifact-2',
      sessionId: 'session-1',
      projectId: null,
      sourcePath,
      sourceHash: null,
      previewUrl: 'http://127.0.0.1:42002/'
    }
  })
  registry.publishSelection('artifact-1', {
    sheet: 'Sheet1',
    range: 'C1',
    paths: ['/Sheet1/C1']
  })
  assert.equal(registry.target(sourcePath, '预算.xlsx')?.selection, undefined)
  assert.equal(registry.activeSheet(sourcePath), undefined)

  registry.publishSelection('artifact-2', {
    sheet: '明细',
    range: 'D1',
    paths: ['/明细/D1']
  })
  registry.publishSelection('artifact-2', null)
  assert.equal(registry.target(sourcePath, '预算.xlsx')?.selection, undefined)
  assert.equal(registry.activeSheet(sourcePath), '明细')
  registry.publish({
    state: 'ready',
    document: {
      artifactId: 'artifact-2',
      sessionId: 'session-1',
      projectId: null,
      sourcePath,
      sourceHash: null,
      previewUrl: 'http://127.0.0.1:42004/'
    }
  })
  assert.equal(registry.activeSheet(sourcePath), '明细')
})

test('the document registry refuses selection state for DOCX targets', () => {
  const registry = new OfficeDocumentRegistry()
  const sourcePath = '/drafts/说明.docx'
  registry.publish({
    state: 'ready',
    document: {
      artifactId: 'artifact-docx',
      sessionId: 'session-1',
      projectId: null,
      kind: 'docx',
      humanEdit: 'none',
      sourcePath,
      sourceHash: null,
      previewUrl: 'http://127.0.0.1:42003/'
    }
  })
  registry.publishSelection('artifact-docx', {
    sheet: 'forged',
    range: 'A1',
    paths: ['/forged/A1']
  })

  assert.deepEqual(registry.target(sourcePath, '说明.docx'), {
    artifactId: 'artifact-docx',
    label: '说明.docx',
    humanEdit: 'none'
  })
})

test('capturing an Office target is unaffected by later visible document changes', () => {
  const visible = { artifactId: 'artifact-1', label: '预算.xlsx' }
  const captured = captureOfficeTarget(visible)

  visible.artifactId = 'artifact-2'
  visible.label = '计划.xlsx'

  assert.deepEqual(captured, { artifactId: 'artifact-1' })
})

test('capturing selection intent never includes renderer-known paths', () => {
  const visible = {
    artifactId: 'artifact-1',
    label: '预算.xlsx',
    selection: { sheet: 'Sheet1', range: 'A1:B3', paths: ['/Sheet1/A1', '/Sheet1/B3'] }
  }
  const captured = captureOfficeTarget(visible)

  visible.selection.range = 'C1:D3'
  visible.selection.paths[0] = '/Sheet1/C1'

  assert.deepEqual(captured, { artifactId: 'artifact-1', includeSelection: true })
})
