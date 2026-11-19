// Desktop actions use the same composer and question controls as an interactive user.
// Disk reads below are observations. They do not dispatch tools or supply model answers.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { focusDesktopSession } from './desktop-layout.mjs'
import { readJsonlFile } from '../../gui-e2e/jsonl.ts'
import { openProjectHome } from '../../gui-e2e/ui.ts'
import { redactSensitiveText } from '../../../src/main/agent/redaction.ts'
import { readAgentUsageRecords } from '../../../src/main/agent/agents/usage-log.ts'
import { getWrapperRunsDir, listWrapperRuns } from '../../../src/main/agent/wrappers/store.ts'

// Recognize the actual fixture tables and workflow output in plain, Markdown or JSON form.
// A gene citation or a link to a results/log file is a valid scientific reference.
const RAW_MARKERS = [
  /\bSYN\d{4}\b[\t| ]+[-+\d.eE]+[\t| ]+[-+\d.eE]+(?=[\s|,"\\}]|$)/i,
  /"gene_id"\s*:\s*"SYN\d{4}"\s*,\s*"(?:baseMean|C1|sample-)/,
  /\bgene_id[\s|,]+(?:baseMean|C1|sample-[a-f0-9]{8,12})\b/i,
  /\bbaseMean[\s|,]+log2FoldChange[\s|,]+lfcSE\b/i,
  /\bschemaVersion[\s|,]+disposition[\s|,]+contrast\b/i,
  /\bgene_set[\s|,]+description[\s|,]+set_size\b/i,
  /\bsample[\t|]+condition\b|\bsample-[a-f0-9]{8,12}[\t|]+(?:treated|control)\b/i,
  /Submitted process >|DESEQ2_DIFFERENTIAL\s*\(|N E X T F L O W|Launching `[^\n]+` \[/i
]
const CHAT = '[data-phi-chat-placement]:visible'
const DONOR = /donor|供体|配对映射/i
const DESCRIPTIVE = /descriptive|描述性|仅.*汇总/i

export function desktopPrompt(kind) {
  assert(['paired', 'zero'].includes(kind))
  const question =
    kind === 'paired'
      ? '同一批供体处理前后有多少基因达到差异表达阈值，是否支持进一步做基因集富集？'
      : '这批配对样本中有多少基因达到差异表达阈值，是否支持进一步做基因集富集？'
  return [
    question,
    `请用已安装的 DESeq2 插件分析 ${kind}/counts.tsv，样本表为 ${kind}/samples.tsv。`,
    '这是配对设计，元数据的 sample 为样本，condition 为分组，比较 treated 相对于 control，供体列名为 donor。',
    `请使用 padj < 0.05 且 |log2FC| ≥ 1 的阈值，将差异分析结果保存在 ${kind}/results。`,
    `如果有符合条件的基因，请用 ${kind}/sets.gmt 做过度富集分析，我同意写入 ${kind}/enrichment.tsv。`,
    '请用中文说明结论和理由，并附上差异分析结果文件，方便我查看基因名单。'
  ].join('\n')
}

export function auditDesktopText(text, location) {
  // A stored handoff can itself be a JSON string. Normalize escaped separators in output previews.
  const content = text
    .replace(/\\+t/g, '\t')
    .replace(/\\+[nr]/g, '\n')
    .replace(/\\+"/g, '"')
  assert(
    !RAW_MARKERS.some((marker) => marker.test(content)),
    `Raw intermediate data appeared in ${location}`
  )
}

function eventList(dir, id) {
  return readJsonlFile(join(dir, id, 'messages.jsonl')).records.map((record) => record.value)
}

function findSession(dir, prompt) {
  if (!existsSync(dir)) return
  return readdirSync(dir, { withFileTypes: true }).find(
    (entry) =>
      entry.isDirectory() &&
      eventList(dir, entry.name).some((e) => e.type === 'user_message' && e.content === prompt)
  )?.name
}

// Parent and specialist event streams both carry start/update/completion for a single call.
function calls(events) {
  const ids = new Map()
  for (const event of events) {
    if (event.type === 'tool_call_completed' || event.type === 'tool_call_started') {
      ids.set(event.toolCallId, event.toolName)
    } else if (event.type === 'agent_execution_step') {
      ids.set(`${event.toolCallId}/${event.step.id}`, event.step.toolName)
    }
  }
  return [...ids.values()]
}

// Store only the first observation of each marker. The map never retains the inspected text.
export function observeDesktopLeaks(leaks, events, visible, now = new Date().toISOString()) {
  for (const event of events) {
    if (event.type === 'user_message') continue
    const key = event.eventId
    if (leaks.has(key)) continue
    try {
      auditDesktopText(JSON.stringify(event), 'main session')
    } catch {
      const tool = event.toolName ?? event.step?.toolName
      leaks.set(key, {
        location: 'saved-session',
        eventType: event.type,
        time: event.createdAt,
        ...(typeof tool === 'string' && /^[a-z][a-z0-9_.:-]{0,63}$/i.test(tool) ? { tool } : {})
      })
    }
  }
  if (!leaks.has('visible-chat')) {
    try {
      auditDesktopText(visible, 'rendered chat')
    } catch {
      leaks.set('visible-chat', { location: 'rendered-chat', eventType: 'visible-text', time: now })
    }
  }
}

function hasDelivery(text, kind) {
  const hitCount =
    kind === 'paired'
      ? /\b50\b|50\s*个/
      : /(?<![\d.])0(?![\d.])|零|未(?:发现|检出|筛到|达到)|没有(?:符合|基因|差异)/
  const enrichment = /ORA|富集|enrichment/i
  const skipped =
    /跳过|未(?:执行|开展|进行|运行|做)|不(?:再|适用|执行|进行|开展|做)|无法.{0,8}富集|无需.{0,8}富集|skipp|no .{0,15}(?:enrichment|ORA)/i
  const enriched = /(?:已(?:完成|进行|执行|检验)|(?:结果|显著|enriched|completed)|SIGNAL)/i
  return (
    hitCount.test(text) &&
    enrichment.test(text) &&
    (kind === 'paired' ? enriched.test(text) : skipped.test(text))
  )
}

const read = (file) => readFileSync(file, 'utf8')
const count = (items, value) => items.filter((item) => item === value).length

function specialistTools(profile, sessionId) {
  const file = sessionId && join(profile.agentDir, 'sessions', sessionId, 'manifest.json')
  if (!file || !existsSync(file)) return []
  const kernelSessionId = JSON.parse(read(file)).kernelRuntimeRef?.kernelSessionId
  if (!kernelSessionId) return []
  return readAgentUsageRecords(profile.agentDir)
    .filter((record) => record.sessionId === kernelSessionId)
    .flatMap((record) => record.tools.map((tool) => tool.name))
}

function attemptedTools(events, specialistCalls) {
  const mainCalls = new Map(
    events.filter((e) => e.type === 'tool_call_started').map((e) => [e.toolCallId, e.toolName])
  )
  return [...mainCalls.values(), ...specialistCalls]
}

function domainCounts(names) {
  return Object.fromEntries(
    ['de_preflight', 'de_assess', 'de_ora'].map((tool) => [tool, count(names, tool)])
  )
}

async function renderedAnswerParts(chat, content) {
  const texts = await chat
    .locator('p:visible,li:visible,h1:visible,h2:visible,h3:visible,td:visible')
    .allInnerTexts()
  const plain = (s) => s.replace(/[\s`*_#|]/g, '')
  return texts.filter((t) => plain(t).length >= 5 && plain(content).includes(plain(t)))
}

function boundedSummary(text) {
  if (!text) return undefined
  try {
    auditDesktopText(text, 'failure summary')
  } catch {
    return undefined
  }
  const redacted = redactSensitiveText(text)
  if (
    redacted !== text ||
    /local-[\da-f]{8}-[\da-f-]{27,}|\b(?:raw-http-request=|authorization:)/i.test(text)
  )
    return undefined
  return text.trim().replace(/\s+/g, ' ').slice(0, 400) || undefined
}

function checkRun(run, kind, fixture, metadata, agentDir) {
  assert.equal(run.wrapper.canonicalId, 'local/modules/differential-expression-deseq2')
  assert.equal(run.executor, 'local')
  assert.equal(run.state, 'completed', 'Expected successful DESeq2 completion')
  assert.equal(run.outDir, fixture.outdir)
  const inputPaths = (id) => run.inputReferences.find((item) => item.id === id)?.localPaths ?? []
  assert(inputPaths('counts').includes(fixture.counts))
  assert(inputPaths('samplesheet').includes(metadata), 'DESeq2 must use the chosen sample mapping')
  const log = read(join(getWrapperRunsDir(agentDir), run.runId, 'nextflow.log'))
  const fits = [...log.matchAll(/Submitted process > DESEQ2_DIFFERENTIAL\b/g)].length
  assert.equal(fits, 1, 'Expected exactly one local DESeq2 process')
  assert.match(read(run.outputs.find((item) => item.id === 'model').path), /donor/)
  const qc = run.researchQc
  assert.equal(qc?.integrityVerified, true)
  assert.equal(qc.evaluated, 1400)
  assert.equal(qc.hits, kind === 'paired' ? 50 : 0)
  assert.equal(qc.disposition, kind === 'paired' ? 'eligible' : 'skip')
  assert.equal(qc.padjThreshold, 0.05)
  assert.equal(qc.log2fcThreshold, 1)
  const enriched = existsSync(fixture.enrichment)
  assert.equal(enriched, kind === 'paired')
  if (enriched) {
    const [header, ...rows] = read(fixture.enrichment)
      .trimEnd()
      .split(/\r?\n/)
      .map((v) => v.split('\t'))
    const signal = rows.find((row) => row[header.indexOf('gene_set')] === 'SIGNAL')
    assert.equal(Number(signal?.[header.indexOf('overlap')]), 50)
  }
  return {
    runId: run.runId,
    disposition: qc.disposition,
    hits: qc.hits,
    evaluated: qc.evaluated,
    fits,
    enrichmentFile: enriched
  }
}

function welcomeButton(page) {
  return page
    .getByRole('dialog')
    .getByRole('button', {
      name: /^(知道了|Got it|跳过.*默认.*|Skip.*defaults.*)$/i
    })
    .last()
}

async function runCase(
  { page, profile, model, providerId, evidenceDir, timeoutMs, onQuestion },
  kind
) {
  const fixture = profile[kind]
  const project = { id: profile.projectId, name: profile.projectName }
  const processCalls = () =>
    existsSync(profile.pluginCallsFile)
      ? read(profile.pluginCallsFile).trim().split('\n').filter(Boolean)
      : []
  const initialCallCount = processCalls().length
  const caseCalls = () => processCalls().slice(initialCallCount)
  const priorRuns = new Set(listWrapperRuns(profile.agentDir).map((run) => run.runId))
  const newRuns = () => listWrapperRuns(profile.agentDir).filter((run) => !priorRuns.has(run.runId))
  const sessionsDir = join(profile.agentDir, 'sessions')
  let chat = page.locator(CHAT).last()
  const sessionFocusChanges = []
  const prompt = desktopPrompt(kind)
  const save = (name, object) =>
    writeFileSync(join(evidenceDir, `${kind}-${name}.json`), JSON.stringify(object, null, 2) + '\n')
  const failedGates = new Set()
  const leaks = new Map()
  const screenshots = new Map()
  const gate = (ok, name) => {
    if (!ok) failedGates.add(name)
  }
  // Hold clean screenshots only in memory until the whole session has passed the leakage check.
  const screenshot = async (name) => {
    const body = await page
      .locator('body')
      .innerText({ timeout: 2000 })
      .catch(() => '')
    if (
      sessionId &&
      (await chat.getAttribute('data-phi-chat-session-id', { timeout: 1000 }).catch(() => null)) ===
        sessionId &&
      !leaks.size &&
      boundedSummary(body)
    )
      screenshots.set(name, await page.screenshot())
  }
  const observe = (events, visible) => {
    observeDesktopLeaks(leaks, events, visible)
    if (leaks.size) {
      failedGates.add('raw-content-in-main-chat')
      screenshots.clear()
    }
  }
  let sessionId
  let paused
  let metadata = fixture.metadata
  let phase = 'submitting'
  let idleSince = 0
  try {
    await openProjectHome(page, project)
    const home = page.locator('[data-phi-home-prompt="true"]:visible').last()
    const picker = home.locator('[data-phi-model-thinking="true"]')
    const normalize = (label) => (label ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const selected = async () =>
      normalize(await picker.getAttribute('aria-label')).includes(normalize(model))
    if (!(await selected())) {
      await picker.click()
      const popover = page.locator('.MuiPopover-root:visible').last()
      await popover.getByRole('textbox').fill(model)
      const group = popover.getByRole('button', { name: new RegExp(providerId, 'i') })
      await group.waitFor({ state: 'visible' })
      if ((await group.getAttribute('aria-expanded')) === 'false') await group.click()
      const matches = await popover.locator('.MuiListItemText-primary').all()
      let picked = false
      for (const option of matches) {
        if (normalize(await option.innerText()) === normalize(model)) {
          await option.click()
          picked = true
          break
        }
      }
      assert(picked, 'Model missing from desktop picker: ' + model)
      await page.keyboard.press('Escape')
      await popover.waitFor({ state: 'hidden' })
    }
    assert(await selected(), 'The expected model must be selected in the desktop composer')
    await home.getByRole('textbox').fill(prompt)
    await home.locator('[data-phi-home-send="true"][data-phi-composer-action="send"]').click()
    await chat.waitFor({ state: 'visible', timeout: 30_000 })
    phase = 'waiting for plugin decisions'
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // While polling there is no other click to trigger the registered obstruction handler.
      // Dispatch the real acknowledgement here without triggering that same handler twice.
      const welcome = welcomeButton(page)
      if (await welcome.isVisible()) await welcome.dispatchEvent('click')
      sessionId ??= findSession(sessionsDir, prompt)
      if (!sessionId) {
        await page.waitForTimeout(100)
        continue
      }
      chat = await focusDesktopSession(page, project, sessionId, sessionFocusChanges)
      const question = chat.getByRole('alert').filter({ has: page.getByRole('radio') })
      const events = eventList(sessionsDir, sessionId)
      const visible = await chat.innerText()
      observe(events, visible)
      const failed = events.findLast((e) => e.type === 'run_failed' || e.type === 'run_interrupted')
      if (failed) {
        failedGates.add(failed.type)
        break
      }
      const approval = chat.getByTestId('gui-e2e-tool-approval')
      if (await approval.isVisible()) {
        const summary = await approval.innerText()
        const expected = /\b(?:de_ora|run_wrapper|wrapper_run)\b/i
        if (expected.test(summary) && (kind === 'zero' || paused)) {
          await approval.getByTestId('gui-e2e-approval-approve').click()
        } else {
          // A simulated user declines out-of-scope access. Keep the failed gate and observe recovery.
          failedGates.add('unexpected-permission-request')
          await approval.getByTestId('gui-e2e-approval-deny').click()
        }
      }

      if (await question.isVisible()) {
        if (kind !== 'paired' || paused) {
          failedGates.add('unexpected-question')
          break
        }
        const panelText = await question.innerText()
        const options = await question
          .locator('label')
          .filter({ has: page.getByRole('radio') })
          .allInnerTexts()
        const hasMappingOption = options.some((o) => DONOR.test(o))
        const hasDescriptiveOption = options.some((o) => DESCRIPTIVE.test(o))
        gate(hasMappingOption && hasDescriptiveOption, 'donor-options')
        if (!hasMappingOption || !(await question.getByRole('textbox').isVisible())) {
          failedGates.add('mapping-cannot-be-submitted')
          break
        }
        gate(caseCalls().includes('de_preflight'), 'preflight-before-question')
        const waiting = Date.now()
        gate(newRuns().length === 0, 'wrapper-before-question')
        await screenshot('waiting')
        await page.waitForTimeout(1800)
        gate(await question.isVisible(), 'waiting-for-explicit-answer')
        const waitingRuns = newRuns().length
        gate(waitingRuns === 0, 'wrapper-while-waiting')
        gate(!existsSync(fixture.enrichment), 'enrichment-before-mapping')
        paused = {
          question: panelText,
          options,
          hasMappingOption,
          hasDescriptiveOption,
          observedWaitingMs: Date.now() - waiting,
          wrapperRunsWhileWaiting: waitingRuns
        }
        await onQuestion?.({ page, question, paused, profile, sessionId })
        metadata = profile.supplyMapping()
        const response = `已补齐供体映射。请使用 ${relative(profile.project, metadata)}，供体列为 donor，按原研究问题继续。`
        await question.getByRole('radio', { name: DONOR }).first().check()
        await question.getByRole('textbox').fill(response)
        gate(newRuns().length === 0, 'wrapper-before-answer-submission')
        await question.getByRole('button', { name: /^(submit|提交)$/i }).click()
        await question.waitFor({ state: 'hidden', timeout: 15_000 })
        phase = 'waiting after donor reply'
        continue
      }

      const lastAnswer = events.findLast((e) => e.type === 'assistant_message_finalized')
      const settled =
        lastAnswer && events.some((e) => e.type === 'run_completed' && e.runId === lastAnswer.runId)
      const runs = newRuns()
      const terminal = events.at(-1)?.type === 'run_completed'
      const outstanding = runs.some((r) => !['completed', 'failed', 'cancelled'].includes(r.state))
      const hasWorker = events.some(
        (e) =>
          e.type === 'agent_execution_background' &&
          !events.some(
            (end) => end.type === 'agent_execution_completed' && end.toolCallId === e.toolCallId
          )
      )
      if (terminal && !hasWorker && !outstanding) {
        idleSince ||= Date.now()
        if (
          (settled &&
            hasDelivery(lastAnswer.content, kind) &&
            hasDelivery(visible, kind) &&
            runs.some((r) => r.state === 'completed') &&
            (kind === 'zero' || existsSync(fixture.enrichment))) ||
          Date.now() - idleSince >= 12_000
        ) {
          phase = 'terminal'
          break
        }
      } else idleSince = 0
      await page.waitForTimeout(300)
    }
    if (Date.now() >= deadline && phase !== 'terminal') failedGates.add('scenario-timeout')
  } catch {
    // Browser/permission errors do not confer scientific completion or authorize another action.
    failedGates.add('desktop-interaction-failed')
  }

  const events = sessionId ? eventList(sessionsDir, sessionId) : []
  const runs = newRuns()
  const assistant = events.findLast((e) => e.type === 'assistant_message_finalized')
  if (sessionId) {
    try {
      chat = await focusDesktopSession(page, project, sessionId, sessionFocusChanges)
    } catch {
      failedGates.add('correct-chat-not-visible')
    }
  }
  chat = page
    .locator(`[data-phi-chat-session-id=${JSON.stringify(sessionId ?? '')}]:visible`)
    .last()
  const visible = await chat.innerText({ timeout: 1500 }).catch(() => '')
  observe(events, visible)
  const parts = assistant ? await renderedAnswerParts(chat, assistant.content).catch(() => []) : []
  const hasVisibleDelivery = Boolean(
    assistant && hasDelivery(assistant.content, kind) && hasDelivery(parts.join('\n'), kind)
  )
  gate(hasVisibleDelivery, 'visible-final-conclusion')
  const toolNames = calls(events)
  const processes = caseCalls()
  const specialistCalls = specialistTools(profile, sessionId)
  const attempts = domainCounts(attemptedTools(events, specialistCalls))
  gate(count(processes, 'de_preflight') >= (kind === 'paired' ? 2 : 1), 'verified-design-preflight')
  gate(
    count(toolNames, 'ask_user_question') === (kind === 'paired' ? 1 : 0),
    'expected-question-count'
  )
  gate(
    kind === 'zero' || (paused?.hasMappingOption && paused?.hasDescriptiveOption),
    'expected-donor-pause'
  )
  gate(processes.includes('de_assess'), 'plugin-results-assessment')
  gate(count(processes, 'de_ora') === (kind === 'paired' ? 1 : 0), 'ora-process-count')
  gate(attempts.de_ora === (kind === 'paired' ? 1 : 0), 'ora-attempt-count')
  gate(runs.length === 1, 'wrapper-count')
  const [run] = runs
  let verified
  if (runs.length === 1) {
    try {
      verified = checkRun(run, kind, fixture, metadata, profile.agentDir)
    } catch {
      failedGates.add('wrapper-evidence')
    }
  }
  const requested = events.find(
    (e) => e.type === 'input_requested' && e.kind === 'ask_user_question'
  )
  const answered = events.find(
    (e) => e.type === 'input_answered' && e.interactionId === requested?.interactionId
  )
  if (kind === 'paired' && run)
    gate(
      answered && Date.parse(answered.createdAt) <= Date.parse(run.createdAt),
      'answer-before-wrapper'
    )
  if (paused)
    Object.assign(paused, {
      askedAt: requested?.createdAt,
      submittedAt: answered?.createdAt,
      wrapperCreatedAt: run?.createdAt
    })
  const resultPath = run?.outputs?.find(
    (entry) => entry.id === 'results' && entry.exists && existsSync(entry.path)
  )?.path
  let linkVisible = false
  if (resultPath && assistant?.content.includes(relative(profile.project, resultPath))) {
    const link = chat
      .locator('[data-phi-slot="local-file-link"]')
      .and(chat.locator(`[data-phi-path=${JSON.stringify(resultPath)}]`))
    linkVisible = await link
      .last()
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(
        () => true,
        () => false
      )
  }
  gate(linkVisible, 'actual-result-link')
  const hasEnrichment = existsSync(fixture.enrichment)
  gate(hasEnrichment === (kind === 'paired'), 'enrichment-output')
  const status = failedGates.size ? 'failed' : 'passed'
  await screenshot(status === 'passed' ? 'delivered' : 'failure').catch(() => {})
  if (!leaks.size)
    for (const [name, buffer] of screenshots)
      writeFileSync(join(evidenceDir, `${kind}-${name}.png`), buffer)
  if (paused && (leaks.size || !boundedSummary(paused.question))) {
    delete paused.question
    delete paused.options
  }
  if (paused) save('pause', paused)
  const summary =
    !leaks.size && boundedSummary(assistant?.content) && boundedSummary(parts.join(' '))
  const result = {
    kind,
    status,
    phase,
    sessionId,
    ...verified,
    failedGates: [...failedGates],
    leaks: [...leaks.values()],
    sessionFocusChanges,
    rawContentDetected: Boolean(leaks.size),
    hasVisibleDelivery,
    historyHasAssistantReply: Boolean(assistant),
    userPrompt: prompt,
    calls: toolNames,
    specialistCalls,
    pluginProcessCalls: processes,
    domainProcesses: domainCounts(processes),
    observedAttempts: attempts,
    attemptSource: 'saved main tool starts and completed specialist usage records',
    wrapperCount: runs.length,
    wrapperStates: runs.map((item) => item.state),
    enrichmentFileExists: hasEnrichment,
    ...(linkVisible ? { resultLink: resultPath } : {}),
    ...(paused ? { paused } : {}),
    ...(kind === 'paired'
      ? {
          donorQuestionRequested: Boolean(requested),
          donorOptionsVerified: Boolean(paused?.hasMappingOption && paused?.hasDescriptiveOption),
          suppliedCorrectedMapping: metadata !== fixture.metadata,
          mappingAnswerSubmitted: Boolean(answered)
        }
      : {}),
    ...(summary
      ? status === 'passed'
        ? { finalAnswer: assistant.content, visibleAnswer: parts }
        : {
            visibleAssistantSummary: {
              source: 'rendered DOM matched to saved assistant reply',
              text: summary
            }
          }
      : {})
  }
  save(status === 'passed' ? 'delivered' : 'failure', result)
  if (status === 'failed' && phase !== 'terminal') {
    // An unexpected question or timeout must not leave a running conversation behind the next one.
    const stop = chat.locator('[data-phi-composer-action="stop"]:visible').last()
    if (await stop.isVisible()) await stop.click({ timeout: 3000 }).catch(() => {})
  }
  return result
}

export async function runDesktopCases({
  page,
  profile,
  model,
  providerId = 'phi-local-acceptance',
  evidenceDir,
  cases = ['paired', 'zero'],
  timeoutMs = 600_000,
  onQuestion,
  onCase
}) {
  mkdirSync(evidenceDir, { recursive: true })
  // First launch may finish asynchronous capability discovery after the first prompt was sent.
  // Close only the two optional bootstrap dialogs, even if they arrive during a composer click.
  const bootstrap = welcomeButton(page)
  await page.addLocatorHandler(bootstrap, (button) => button.click(), { noWaitAfter: true })
  return observeDesktopCases(
    cases,
    (kind) =>
      runCase({ page, profile, model, providerId, evidenceDir, timeoutMs, onQuestion }, kind),
    onCase
  )
}

export async function observeDesktopCases(cases, observeCase, onCase) {
  const results = {}
  for (const kind of cases) {
    try {
      results[kind] = await observeCase(kind)
    } catch {
      // Infrastructure errors can contain prompt/body text. Keep the case attribution only.
      results[kind] = { kind, status: 'failed', failedGates: ['case-observer-failed'] }
    }
    await onCase?.(kind, results[kind])
  }
  if (results.paired?.sessionId && results.zero?.sessionId)
    assert.notEqual(results.paired.sessionId, results.zero.sessionId)
  const failed = Object.values(results)
    .filter((r) => r.status === 'failed')
    .map((r) => r.kind)
  if (failed.length)
    throw new Error(
      `Desktop acceptance failed for ${failed.join(', ')}; see scoped case diagnostics.`
    )
  return results
}
