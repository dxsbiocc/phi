#!/usr/bin/env bun

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArguments } from './lib/args.mjs'
import {
  CdpClient,
  ConsoleEvidence,
  discoverPageTarget,
  redactConsoleText
} from './lib/cdp.mjs'
import {
  launchPackagedApp,
  prepareRun,
  reserveFreePort,
  terminateOwnedProcessTree,
  writeRunMetadata
} from './lib/runtime.mjs'
import { PhiUi, SELECTORS } from './lib/ui.mjs'

const {
  dryRun: DRY_RUN,
  remoteOnly: REMOTE_ONLY,
  localOnly: LOCAL_ONLY
} = parseArguments(process.argv)
const WHOLE_RUN_TIMEOUT_MS = 45 * 60_000
const DRY_RUN_TIMEOUT_MS = 3 * 60_000
const MODEL_TIMEOUT_MS = Number(process.env.G4_MODEL_TIMEOUT_MS) || 4 * 60_000
const STEP_TIMEOUT_MS = Number(process.env.G4_STEP_TIMEOUT_MS) || 13 * 60_000
const LOCAL_STEP_IDS = ['F1', 'F2', 'F3', 'F4', 'F6', 'M1', 'M2', 'M3']
const REMOTE_STEP_IDS = ['F5', 'M4', 'M5']
const STEP_IDS = [
  ...(REMOTE_ONLY ? [] : LOCAL_STEP_IDS),
  ...(LOCAL_ONLY ? [] : REMOTE_STEP_IDS)
]
// The remote project the acceptance data copy already contains, by SSH host alias and name.
const REMOTE_HOST = process.env.G4_REMOTE_HOST || 'GPU'
const REMOTE_PROJECT = process.env.G4_REMOTE_PROJECT || 'software'
// Any remote directory has entries to list; it need not contain a README.
const REMOTE_SUBAGENT_PROMPT = '用一个子智能体列出项目根目录下的文件，只返回文件名列表'
const PROMPT_BUDGET = 20

let run = null
let appProcess = null
let client = null
let consoleEvidence = new ConsoleEvidence()
let results = []
let promptsSent = 0
let cleanupPromise = null
const runAbortController = new AbortController()

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function relativeRunPath(target) {
  return run ? path.relative(run.runDir, target) : target
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function markdownCell(value) {
  return oneLine(redactConsoleText(value)).replaceAll('|', '\\|')
}

function redactEvidence(value) {
  if (typeof value === 'string') return redactConsoleText(value)
  if (Array.isArray(value)) return value.map(redactEvidence)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactEvidence(item)]))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function writeResults() {
  if (!run) return
  await writeFile(run.resultsPath, `${JSON.stringify(redactEvidence(results), null, 2)}\n`, { mode: 0o600 })
}

async function writeSummary(extra = '') {
  if (!run) return
  const rows = results.map((result) => {
    const screenshots = (result.evidence?.screenshots ?? []).join('<br>') || '—'
    return `| ${result.id} | ${result.status} | ${markdownCell(result.reason)} | ${screenshots} |`
  })
  const body = [
    '# G4 验收摘要',
    '',
    `- 运行模式：${DRY_RUN ? 'dry-run（不发送提示词）' : '完整验收'}`,
    `- 开始目录：\`${run.runDir}\``,
    `- 提示词调用：${promptsSent} / ${PROMPT_BUDGET}`,
    '',
    '| ID | 状态 | 一句话说明 | 截图 |',
    '| --- | --- | --- | --- |',
    ...(rows.length ? rows : ['| — | — | 未执行验收步骤 | — |']),
    '',
    extra
  ].join('\n')
  await writeFile(run.summaryPath, `${body.trim()}\n`, { mode: 0o600 })
}

async function flushEvidence() {
  if (!run) return
  await Promise.all([writeResults(), writeSummary(), consoleEvidence.flush(run.consolePath)])
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    client?.close()
    await terminateOwnedProcessTree(appProcess)
    await flushEvidence().catch(() => undefined)
  })()
  return cleanupPromise
}

function usePromptBudget(count = 1) {
  if (promptsSent + count > PROMPT_BUDGET) {
    throw new Error(`Prompt budget exceeded (${promptsSent + count}/${PROMPT_BUDGET})`)
  }
  promptsSent += count
}

async function sendPrompt(ui, text, options = {}) {
  usePromptBudget()
  return ui.sendPrompt(text, { timeoutMs: MODEL_TIMEOUT_MS, ...options })
}

async function withTimeout(promise, timeoutMs, label, onTimeout = null) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.()
      const error = new Error(`${label} timed out after ${timeoutMs} ms`)
      error.name = 'TimeoutError'
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function isTimeoutError(error) {
  return (
    error?.name === 'TimeoutError' ||
    /\b(?:timed out|timeout)\b|exceeded \d+ ms/i.test(errorText(error))
  )
}

async function screenshotForStep(id) {
  const shot = path.join(run.shots, `${id}-final.png`)
  await client.screenshot(shot)
  return relativeRunPath(shot)
}

async function recordStep(ui, id, operation, options = {}) {
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  let baseline = null
  let outcome = null
  let probe = { events: [], newAssistantErrors: [], session: null }
  let operationError = null
  let screenshot = null
  let stepTimedOut = false

  try {
    baseline = await ui.beginStep(id)
    outcome = await withTimeout(
      operation(),
      options.timeoutMs ?? STEP_TIMEOUT_MS,
      `${id} step`,
      () => {
        stepTimedOut = true
        runAbortController.abort()
        void cleanup()
      }
    )
  } catch (error) {
    operationError = error
  }

  if (operationError && isTimeoutError(operationError) && !stepTimedOut) {
    stepTimedOut = true
    runAbortController.abort()
    void cleanup()
  }

  if (stepTimedOut) {
    const result = {
      id,
      status: 'FAIL',
      startedAt,
      durationMs: Date.now() - startedMs,
      evidence: { notices: [], assistantStopErrors: [], screenshots: [] },
      reason: errorText(operationError)
    }
    results.push(result)
    await Promise.all([writeResults(), writeSummary(), consoleEvidence.flush(run.consolePath)])
    throw operationError
  }

  if (runAbortController.signal.aborted) {
    throw operationError ?? new Error(`${id} aborted with the acceptance workflow`)
  }

  try {
    if (baseline) probe = await ui.finishStep(baseline)
  } catch (error) {
    operationError ??= error
  }

  try {
    screenshot = await screenshotForStep(id)
  } catch (error) {
    operationError ??= new Error(`Screenshot failed: ${errorText(error)}`)
  }

  if (runAbortController.signal.aborted) {
    throw operationError ?? new Error(`${id} aborted with the acceptance workflow`)
  }

  // A step that provokes a refusal names it, so that notice is its evidence, not a failure.
  const expectedErrors = options.expectedErrors ?? []
  const transientErrors = (probe.events ?? []).filter(
    (event) =>
      event.severity === 'error' && !expectedErrors.some((text) => String(event.text).includes(text))
  )
  const assistantErrors = probe.newAssistantErrors ?? []
  const allowRemoteConnectionBlock =
    id === 'F5' &&
    outcome?.status === 'BLOCKED' &&
    outcome?.evidence?.remoteConnectionBlocked === true
  let status = outcome?.status ?? 'PASS'
  let reason = outcome?.reason ?? '检查通过'
  if (operationError) {
    status = 'FAIL'
    reason = errorText(operationError)
  } else if ((transientErrors.length || assistantErrors.length) && !allowRemoteConnectionBlock) {
    status = 'FAIL'
    const details = [
      ...transientErrors.map((event) => event.text),
      ...assistantErrors.map((event) => event.errorMessage || event.content || 'stopReason: error')
    ].filter(Boolean)
    reason = `步骤出现错误：${oneLine(details.join('；'))}`
  }

  const evidence = {
    ...(outcome?.evidence ?? {}),
    notices: probe.events ?? [],
    assistantStopErrors: assistantErrors,
    screenshots: [
      ...(outcome?.evidence?.screenshots ?? []).map(relativeRunPath),
      ...(screenshot ? [screenshot] : [])
    ]
  }
  const result = {
    id,
    status,
    startedAt,
    durationMs: Date.now() - startedMs,
    evidence,
    reason
  }
  results.push(result)
  await Promise.all([writeResults(), writeSummary(), consoleEvidence.flush(run.consolePath)])
  if (operationError && isTimeoutError(operationError)) throw operationError
  return result
}

async function recordBlocked(id, reason, evidence = {}) {
  const shot = client ? await screenshotForStep(id).catch(() => null) : null
  const result = {
    id,
    status: 'BLOCKED',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    evidence: { ...evidence, screenshots: shot ? [shot] : [] },
    reason
  }
  results.push(result)
  await writeResults()
  return result
}

async function runDry(ui, projectName) {
  const homeShot = path.join(run.shots, 'dry-run-home.png')
  await client.screenshot(homeShot)
  const report = await ui.verifyDryRunSelectors(projectName)
  const sessionShot = path.join(run.shots, 'dry-run-session.png')
  await client.screenshot(sessionShot)
  const failures = [
    ...Object.entries(report.home),
    ...Object.entries(report.session)
  ].filter(([, exists]) => !exists)
  const dryReport = {
    mode: 'dry-run',
    createdAt: new Date().toISOString(),
    promptsSent,
    screenshots: [relativeRunPath(homeShot), relativeRunPath(sessionShot)],
    selectors: report,
    failures: failures.map(([name]) => name)
  }
  await writeFile(path.join(run.runDir, 'dry-run.json'), `${JSON.stringify(dryReport, null, 2)}\n`, {
    mode: 0o600
  })
  results = [
    {
      id: 'DRY',
      status: failures.length ? 'FAIL' : 'PASS',
      startedAt: dryReport.createdAt,
      durationMs: 0,
      evidence: { ...dryReport, screenshots: dryReport.screenshots },
      reason: failures.length
        ? `缺少必要选择器：${failures.map(([name]) => name).join('、')}`
        : '主页和新会话的静态选择器可用；条件式选择器未触发模型调用'
    }
  ]
  await writeResults()
  await writeSummary(
    '条件式选择器（消息分叉、子智能体、错误提示）只有在对应运行时状态出现；dry-run 按要求不发送提示词，因此仅记录其来源与延迟验证原因。'
  )
  return failures.length === 0
}

async function runFull(ui, projectName) {
  if (!REMOTE_ONLY) {
    await ui.openNewProjectSession(projectName)
    await runLocal(ui)
  }
  if (!LOCAL_ONLY) await runRemote(ui)
  const seen = new Set(results.map((item) => item.id))
  for (const id of STEP_IDS) {
    if (!seen.has(id)) await recordBlocked(id, '前置步骤未完成')
  }
}

async function runLocal(ui) {
  const forkPrompts = [
    '第1轮：请只回答“一”。',
    '第2轮：请只回答“二”。',
    '第3轮：请只回答“三”。'
  ]
  const forkReplies = []
  let sourceTitle = ''
  let sourceId = ''
  let forkTitle = ''
  let f6StreamingObserved = false

  await recordStep(
    ui,
    'F1',
    async () => {
      for (const prompt of forkPrompts) {
        const sent = await sendPrompt(ui, prompt)
        assert(sent.assistantText, `No assistant reply for ${prompt}`)
        forkReplies.push(sent.assistantText)
      }
      const beforeFork = await ui.snapshot()
      sourceTitle = beforeFork.activeSessionTitle
      sourceId = await ui.currentSessionId()
      assert(sourceTitle && sourceId, 'Source session title or id is empty')
      assert(beforeFork.forkButtonCount >= 3, `Expected 3 fork controls, got ${beforeFork.forkButtonCount}`)
      await ui.forkMessage(1)
      const forked = await client.waitForValue(
        `
          (() => {
            const row = document.querySelector(${JSON.stringify(SELECTORS.activeSessionRow)});
            const title = row?.closest('[data-phi-session-row-shell="true"]')?.querySelector('.session-title')?.textContent?.trim() || '';
            return title.includes('（分叉）') ? title : '';
          })()
        `,
        { timeoutMs: 60_000, description: 'fork session title' }
      )
      forkTitle = forked
      return {
        reason: '第二条用户消息成功创建带“（分叉）”标题的新会话',
        evidence: { sourceTitle, forkTitle, prompts: forkPrompts, assistantReplies: forkReplies }
      }
    },
    { timeoutMs: STEP_TIMEOUT_MS }
  )

  await recordStep(ui, 'F2', async () => {
    const snapshot = await ui.snapshot()
    assert(snapshot.users.length === 2, `Fork contains ${snapshot.users.length} user messages, expected 2`)
    assert(snapshot.users[0].includes(forkPrompts[0]), 'Fork is missing the first user message')
    assert(snapshot.users[1].includes(forkPrompts[1]), 'Fork is missing the second user message')
    assert(!snapshot.users.some((text) => text.includes(forkPrompts[2])), 'Fork contains the third user message')
    const assistantTexts = snapshot.session.assistants
      .map((item) => item.content.trim())
      .filter(Boolean)
    assert(assistantTexts.length === 2, `Fork contains ${assistantTexts.length} assistant replies, expected 2`)
    assert(oneLine(assistantTexts[0]) === oneLine(forkReplies[0]), 'Fork is missing the first assistant reply')
    assert(oneLine(assistantTexts[1]) === oneLine(forkReplies[1]), 'Fork is missing the second assistant reply')
    assert(!assistantTexts.some((text) => oneLine(text) === oneLine(forkReplies[2])), 'Fork contains the third assistant reply')
    return {
      reason: '分叉仅保留前两轮用户消息；未出现第三轮',
      evidence: {
        userMessages: snapshot.users,
        assistantTexts
      }
    }
  })

  await recordStep(ui, 'F3', async () => {
    const sent = await sendPrompt(ui, '我们刚才聊到第几轮？只回答数字。')
    assert(sent.assistantText, 'Fork follow-up returned no assistant text')
    return {
      reason: '分叉追问获得正常回复，内容留给复核者判断',
      evidence: { assistantText: sent.assistantText }
    }
  })

  await recordStep(ui, 'F4', async () => {
    const snapshot = await ui.openSessionById(sourceId)
    assert(snapshot.users.length === 3, `Source contains ${snapshot.users.length} user messages, expected 3`)
    for (const prompt of forkPrompts) {
      assert(snapshot.users.some((text) => text.includes(prompt)), `Source is missing ${prompt}`)
    }
    return {
      reason: '来源会话仍完整保留三轮用户消息',
      evidence: { sourceTitle, userMessages: snapshot.users }
    }
  })

  await recordStep(ui, 'F6', async () => {
    const before = await ui.snapshot()
    const prompt = '请写一篇至少 1200 字的长说明，分成十段，逐段解释如何保持大型软件项目可维护。'
    usePromptBudget()
    const started = await ui.startPromptAndForkWhileStreaming(prompt, before.forkButtonCount - 1)
    f6StreamingObserved = started.streamingObserved
    if (!started.outcome.triggered) {
      return {
        status: 'FAIL',
        reason: '发送长回答前，本地来源消息没有可用的分叉控件',
        evidence: { triggerMethod: 'captured fork UI handler after streaming begins', trigger: started.outcome }
      }
    }
    const notice = await ui.findNoticeContainingOrNull('请等待来源会话运行结束后再分叉', 20_000)
    const snapshot = await ui.snapshot()
    return {
      status: notice ? 'PASS' : 'FAIL',
      reason: notice ? '运行中的来源会话拒绝分叉并显示预期提示' : '未观察到运行中分叉的预期提示',
      evidence: {
        triggerMethod: '发送后观察到停止按钮，再调用发送前捕获的分叉 UI 处理器',
        trigger: started.outcome,
        expectedNotice: '请等待来源会话运行结束后再分叉',
        observedNotice: notice,
        activeSessionTitle: snapshot.activeSessionTitle
      }
    }
  }, { expectedErrors: ['请等待来源会话运行结束后再分叉'] })
  if (f6StreamingObserved) await ui.waitForGenerationToFinish(MODEL_TIMEOUT_MS, true)
  if (sourceId) await ui.openSessionById(sourceId)

  await recordStep(ui, 'M1', async () => {
    const sent = await sendPrompt(ui, '用一个子智能体读 README.md，只返回前三行', {
      observeSelectors: [SELECTORS.childRun]
    })
    const childAppeared = sent.observed[SELECTORS.childRun]
    assert(childAppeared, 'No child-run UI element appeared')
    assert(sent.assistantText.includes(run.marker), 'Final assistant output does not contain the README marker')
    return {
      reason: '子智能体卡片出现，且最终助手文本包含运行时 README 标记',
      evidence: {
        childRunAppeared: childAppeared,
        assistantText: sent.assistantText,
        marker: run.marker
      }
    }
  })

  await recordStep(ui, 'M2', async () => {
    let compaction = await ui.inspectContextAndCompact('M2', { allowNotNeeded: true })
    // OMP keeps about 20k recent tokens (scaled down by the system prompt's share), so a
    // conversation of a few short turns and one essay can sit right at the edge.
    const growthTopics = ['测试、发布和回滚', '代码评审与重构', '监控、告警和故障复盘']
    let grownBy = 0
    while (compaction.notNeeded) {
      assert(grownBy < growthTopics.length, 'Still too short to compact after growing the conversation')
      const topic = growthTopics[grownBy]
      grownBy += 1
      const grown = await sendPrompt(ui, `请写一篇至少 3000 字的长文，分成十五段，逐段解释软件项目里${topic}的做法。`)
      assert(grown.assistantText, 'No assistant reply while growing the conversation for compaction')
      compaction = await ui.inspectContextAndCompact('M2', { allowNotNeeded: grownBy < growthTopics.length })
    }
    const sent = await sendPrompt(ui, '继续，用一句话总结我们之前在做什么')
    assert(sent.assistantText, 'No assistant reply after manual compaction')
    return {
      reason: '手动压缩成功，随后继续对话获得正常回复',
      evidence: {
        compactionRoute: compaction.route,
        compactionNotice: compaction.success,
        grownBeforeCompaction: grownBy,
        assistantText: sent.assistantText,
        screenshots: [compaction.contextShot]
      }
    }
  })

  await recordStep(ui, 'M3', async () => {
    const prompt = '写一篇约 800 字的说明，主题随意'
    const baseline = await ui.snapshot()
    usePromptBudget()
    await ui.typePrompt(prompt)
    await ui.clickSelector(SELECTORS.send)
    await client.waitForValue(`Boolean(document.querySelector(${JSON.stringify(SELECTORS.stop)}))`, {
      timeoutMs: 20_000,
      description: 'M3 streaming state'
    })
    const switchResult = await ui.switchToDifferentModel()
    await ui.waitForGenerationToFinish(MODEL_TIMEOUT_MS, true)
    const streamed = await ui.snapshot()
    const streamedText =
      streamed.session.assistants.slice(baseline.session.assistants.length).at(-1)?.content ||
      streamed.assistantText
    if (!switchResult.changed) {
      return {
        status: 'BLOCKED',
        reason: '仅发现一个可选模型，无法执行流式期间切换',
        evidence: { switchResult, streamingAssistantText: streamedText }
      }
    }
    assert(switchResult.selected?.includes('/') && switchResult.changed, 'A different model was not selected')
    assert(
      switchResult.available.length > 1 && switchResult.after,
      'Model switch did not expose a distinct selected model'
    )
    assert(switchResult.streamingAtSelection, 'Model selection occurred after streaming had finished')
    assert(streamedText, 'Streaming reply did not finish with assistant text')
    const hello = await sendPrompt(ui, '你好')
    assert(hello.assistantText, 'Post-switch “你好” returned no assistant text')
    const replyModel = await ui.currentModel()
    return {
      reason: '流式回复在切换模型后正常结束，下一轮也获得回复',
      evidence: {
        switchResult,
        streamingAssistantText: streamedText,
        assistantText: hello.assistantText,
        model: replyModel
      }
    }
  })

}

async function runRemote(ui) {
  const projects = await ui.listProjectMetadata()
  const remoteProject = projects.find(
    (project) =>
      project.name === REMOTE_PROJECT && project.kind === 'ssh' && project.host === REMOTE_HOST
  )
  let remoteReady = false
  let remoteBlockReason = ''

  const remoteConnectionBlock = async (error) => {
    const [blockedSnapshot, events] = await Promise.all([
      ui.snapshot().catch(() => ({ notices: [] })),
      ui.currentStepEvents().catch(() => [])
    ])
    const candidates = [
      ...(blockedSnapshot.notices ?? []),
      ...events.map((event) => event.text).filter(Boolean)
    ]
    const visibleNotices = [...new Set(candidates.map(oneLine).filter(Boolean))]
    const connectionNotices = visibleNotices.filter((text) =>
      /远程.*(?:连接|不可用|失败)|连接.*(?:失败|不可用)|server.*unavailable|ssh/i.test(text)
    )
    if (!connectionNotices.length) return null
    const visibleError = connectionNotices.join('；')
    remoteBlockReason = `远程项目无法连接：${visibleError}`
    return {
      status: 'BLOCKED',
      reason: remoteBlockReason,
      evidence: {
        remoteConnectionBlocked: true,
        remoteProject,
        visibleError,
        visibleNotices,
        driverError: errorText(error)
      }
    }
  }

  await recordStep(ui, 'F5', async () => {
    if (!remoteProject) {
      remoteBlockReason = `数据副本中未找到 ${REMOTE_HOST} 上名为 ${REMOTE_PROJECT} 的远程项目`
      return { status: 'BLOCKED', reason: remoteBlockReason, evidence: { projects } }
    }
    try {
      await ui.openNewProjectSession(remoteProject.name, { projectIndex: remoteProject.index })
    } catch (error) {
      const blocked = await remoteConnectionBlock(error)
      if (blocked) return blocked
      throw error
    }
    let sent
    try {
      sent = await sendPrompt(ui, '请只回复：远程分叉准备好')
    } catch (error) {
      const blocked = await remoteConnectionBlock(error)
      if (blocked) return blocked
      throw error
    }
    assert(sent.assistantText, 'Remote preparation turn returned no reply')
    const snapshot = await ui.snapshot()
    const sourceTitle = snapshot.activeSessionTitle
    if (!snapshot.forkButtonCount) {
      return {
        status: 'FAIL',
        reason: '远程消息未暴露分叉控件',
        evidence: { forkButtonCount: snapshot.forkButtonCount, assistantText: sent.assistantText }
      }
    }
    await ui.forkMessage(snapshot.forkButtonCount - 1)
    // Title generation also renames the source session, so only a "（分叉）" title proves the
    // fork opened; a remote fork takes several seconds.
    const forkTitle = await client.waitForValue(
      `
        (() => {
          const row = document.querySelector(${JSON.stringify(SELECTORS.activeSessionRow)});
          const title = row?.closest('[data-phi-session-row-shell="true"]')?.querySelector('.session-title')?.textContent?.trim() || '';
          return title.includes('（分叉）') ? title : '';
        })()
      `,
      { timeoutMs: 120_000, description: 'remote fork session title' }
    )
    const forked = await ui.snapshot()
    assert(forked.users.length === 1, `Remote fork contains ${forked.users.length} user messages, expected 1`)
    remoteReady = true
    return {
      reason: '远程会话从消息分叉成功，新会话保留来源消息',
      evidence: {
        sourceTitle,
        forkTitle,
        userMessages: forked.users,
        assistantText: sent.assistantText
      }
    }
  })

  if (!remoteReady) {
    await recordBlocked('M4', remoteBlockReason || 'F5 未建立可用的远程会话')
    await recordBlocked('M5', remoteBlockReason || 'F5 未建立可用的远程会话')
  } else {
    await recordStep(ui, 'M4', async () => {
      const sent = await sendPrompt(ui, '回复 ok 即可')
      assert(sent.assistantText, 'Remote M4 returned no assistant text')
      return { reason: '远程会话获得正常助手回复', evidence: { assistantText: sent.assistantText } }
    })

    await recordStep(ui, 'M5', async () => {
      const sent = await sendPrompt(ui, process.env.G4_SUBAGENT_PROMPT || REMOTE_SUBAGENT_PROMPT, {
        observeSelectors: [SELECTORS.childRun]
      })
      assert(sent.assistantText, 'Remote M5 returned no assistant text')
      assert(sent.observed[SELECTORS.childRun], 'No remote child-run UI element appeared')
      return {
        reason: '远程子智能体请求获得无错误回复；内容留给复核者判断',
        evidence: {
          childRunAppeared: sent.observed[SELECTORS.childRun],
          assistantText: sent.assistantText
        }
      }
    })
  }

}

async function executeConnected(port) {
  const target = await discoverPageTarget(port, {
    timeoutMs: 60_000,
    signal: runAbortController.signal
  })
  client = new CdpClient(target.webSocketDebuggerUrl, consoleEvidence)
  runAbortController.signal.addEventListener('abort', () => client?.close(), { once: true })
  await client.connect()
  const ui = new PhiUi(client, run)
  await ui.waitForApp()
  await ui.enforceChineseUi()
  // Without G4_MODEL the run uses the data copy's own default model.
  if (process.env.G4_MODEL) {
    const defaultModel = await ui.selectDefaultModel(process.env.G4_MODEL)
    await writeFile(path.join(run.runDir, 'default-model.json'), JSON.stringify(defaultModel))
  }

  const projectName = `G4 验收 ${path.basename(run.runDir)}`
  await ui.addLocalProject(projectName)
  await ui.openHome()
  const setupShot = path.join(run.shots, 'setup-home.png')
  await client.screenshot(setupShot)

  if (DRY_RUN) return runDry(ui, projectName)
  await runFull(ui, projectName)
  return !results.some((result) => result.status !== 'PASS')
}

async function execute() {
  run = await prepareRun()
  if (runAbortController.signal.aborted) throw new Error('Acceptance workflow aborted during run preparation')
  await Promise.all([writeResults(), writeSummary(), consoleEvidence.flush(run.consolePath)])
  const port = await reserveFreePort()
  if (runAbortController.signal.aborted) throw new Error('Acceptance workflow aborted before app launch')
  appProcess = launchPackagedApp(run, port)
  await writeRunMetadata(run, {
    mode: DRY_RUN ? 'dry-run' : REMOTE_ONLY ? 'remote-only' : LOCAL_ONLY ? 'local-only' : 'full',
    cdpPort: port,
    appProcessId: appProcess.pid
  })
  let workflowSettled = false
  const workflow = executeConnected(port)
  const unexpectedExit = appProcess.exited.then((exitCode) => {
    if (workflowSettled) return false
    runAbortController.abort()
    throw new Error(`Packaged Phi exited unexpectedly with code ${exitCode}`)
  })
  try {
    return await Promise.race([workflow, unexpectedExit])
  } finally {
    workflowSettled = true
  }
}

async function main() {
  const timeoutMs = DRY_RUN ? DRY_RUN_TIMEOUT_MS : WHOLE_RUN_TIMEOUT_MS
  let succeeded = false
  try {
    succeeded = await withTimeout(
      execute(),
      timeoutMs,
      DRY_RUN ? 'dry-run' : 'whole run',
      () => runAbortController.abort()
    )
  } catch (error) {
    runAbortController.abort()
    const message = errorText(error)
    if (run && DRY_RUN && results.length === 0) {
      results.push({
        id: 'DRY',
        status: 'BLOCKED',
        startedAt: new Date().toISOString(),
        durationMs: 0,
        evidence: { screenshots: [], promptsSent },
        reason: `dry-run 提前终止：${message}`
      })
    } else if (run && !DRY_RUN) {
      const seen = new Set(results.map((item) => item.id))
      for (const id of STEP_IDS) {
        if (!seen.has(id)) {
          results.push({
            id,
            status: 'BLOCKED',
            startedAt: new Date().toISOString(),
            durationMs: 0,
            evidence: { screenshots: [] },
            reason: `驱动提前终止：${message}`
          })
        }
      }
    }
    console.error(redactConsoleText(message))
    process.exitCode = 1
    await flushEvidence().catch(() => undefined)
  } finally {
    await cleanup()
    await flushEvidence().catch(() => undefined)
  }

  if (!succeeded && process.exitCode == null) {
    process.exitCode = results.some((result) => result.status === 'FAIL') ? 1 : 2
  }
}

let signalHandled = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (signalHandled) return
    signalHandled = true
    runAbortController.abort()
    process.exitCode = 1
    void cleanup().finally(() => process.exit())
  })
}

await main()
