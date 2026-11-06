import path from 'node:path'
import { dispatchSelectAllAndInsert, sleep } from './cdp.mjs'
import {
  DOM_SNAPSHOT_SCRIPT,
  PROBE_SCRIPT,
  SELECTORS,
  SESSION_EVIDENCE_SCRIPT
} from './renderer-contract.mjs'

export { SELECTORS } from './renderer-contract.mjs'

const q = (value) => JSON.stringify(value)

export class PhiUi {
  constructor(client, run) {
    this.client = client
    this.run = run
  }

  async installProbe() {
    await this.client.evaluate(PROBE_SCRIPT)
  }

  async selectDefaultModel(name) {
    const selected = await this.client.evaluate(`
      (async () => {
        const model = (await window.api.listModels()).find((item) => item.name === ${q(name)});
        if (!model) throw new Error('Model is unavailable: ' + ${q(name)});
        await window.api.selectModel(model.providerId, model.modelId, 'new-session');
        return window.api.getSelectedModel('new-session');
      })()
    `, { awaitPromise: true })
    const previousTimeOrigin = await this.client.evaluate(`performance.timeOrigin`)
    await this.client.evaluate(`setTimeout(() => location.reload(), 0); true`)
    await this.client.waitForValue(`performance.timeOrigin !== ${previousTimeOrigin}`, {
      timeoutMs: 30_000,
      description: 'renderer reload after model selection'
    })
    await this.waitForApp()
    return selected
  }

  async waitForApp() {
    await this.client.waitForValue(
      `Boolean(window.api && document.querySelector(${q(SELECTORS.settings)}))`,
      { timeoutMs: 60_000, description: 'Phi renderer and settings control' }
    )
    await this.installProbe()
  }

  async enforceChineseUi() {
    const language = await this.client.evaluate(`document.documentElement.lang || ''`)
    if (language === 'zh-CN') return false
    const previousTimeOrigin = await this.client.evaluate(`performance.timeOrigin`)
    await this.client.evaluate(
      `localStorage.setItem('phi.uiLanguage', 'zh-CN'); setTimeout(() => location.reload(), 0); true`
    )
    await this.client.waitForValue(`performance.timeOrigin !== ${previousTimeOrigin}`, {
      timeoutMs: 30_000,
      description: 'renderer reload after language change'
    })
    await this.waitForApp()
    const next = await this.client.evaluate(`document.documentElement.lang || ''`)
    if (next !== 'zh-CN') throw new Error(`Expected Simplified Chinese UI, got ${next || 'unset'}`)
    return true
  }

  async beginStep(id) {
    await this.installProbe()
    await this.client.evaluate(`window.__phiG4Probe.start(${q(id)})`)
    return this.sessionEvidence()
  }

  async finishStep(baseline) {
    const [events, session] = await Promise.all([
      this.client.evaluate(`window.__phiG4Probe.finish()`),
      this.sessionEvidence()
    ])
    const baselineKeys = new Set((baseline?.assistantErrors ?? []).map((item) => item.key))
    return {
      events,
      session,
      newAssistantErrors: session.assistantErrors.filter((item) => !baselineKeys.has(item.key))
    }
  }

  async currentStepEvents() {
    return this.client.evaluate(`window.__phiG4Probe?.peek?.() || []`)
  }

  sessionEvidence() {
    return this.client.evaluate(SESSION_EVIDENCE_SCRIPT, { timeoutMs: 30_000 })
  }

  async snapshot() {
    const [dom, session] = await Promise.all([
      this.client.evaluate(DOM_SNAPSHOT_SCRIPT),
      this.sessionEvidence()
    ])
    return { ...dom, session }
  }

  async addLocalProject(name) {
    const result = await this.client.evaluate(`
      (async () => {
        const target = ${q(this.run.project)};
        const existing = (await window.api.listProjects()).find((project) =>
          project.location?.kind === 'local' &&
          (project.location.path === target || project.workingDirectory === target)
        );
        const project = existing || await window.api.createProject(${q(name)}, target, 'auto');
        return { id: project.id, name: project.name, kind: project.location?.kind || 'local' };
      })()
    `)
    const previousTimeOrigin = await this.client.evaluate(`performance.timeOrigin`)
    await this.client.evaluate(`setTimeout(() => location.reload(), 0); true`)
    await this.client.waitForValue(`performance.timeOrigin !== ${previousTimeOrigin}`, {
      timeoutMs: 30_000,
      description: 'renderer reload after project creation'
    })
    await this.waitForApp()
    return result
  }

  async listProjectMetadata() {
    return this.client.evaluate(`
      window.api.listProjects().then((projects) => projects.map((project, index) => ({
        index,
        id: project.id,
        name: project.name,
        kind: project.location?.kind || 'local',
        host: project.remoteHostAlias || '',
        pathAvailable: project.pathAvailable !== false,
        connectionPhase: project.remoteConnection?.phase || project.remoteReachability || ''
      })))
    `)
  }

  async navigateProjects() {
    await this.clickSelector(SELECTORS.projectsNavigation)
    await this.client.waitForValue(`Boolean(document.querySelector(${q(SELECTORS.projectRow)}))`, {
      timeoutMs: 20_000,
      description: 'project rows'
    })
  }

  async openHome() {
    await this.clickSelector(SELECTORS.conversationsNavigation)
    await this.client.waitForValue(
      `[...document.querySelectorAll('button')].some((button) => (button.innerText || '').trim() === '新对话')`,
      { timeoutMs: 20_000, description: 'new conversation control' }
    )
    await this.clickText('新对话', 'button')
    await this.client.waitForValue(`Boolean(document.querySelector(${q(SELECTORS.homePrompt)}))`, {
      timeoutMs: 20_000,
      description: 'home prompt'
    })
  }

  async openNewProjectSession(name, options = {}) {
    await this.navigateProjects()
    const projectIndex = Number.isInteger(options.projectIndex) ? options.projectIndex : null
    const locator = `
      (() => {
        const rows = [...document.querySelectorAll(${q(SELECTORS.projectRow)})];
        const indexed = ${projectIndex === null ? 'null' : `rows[${projectIndex}]`};
        if (indexed && (indexed.innerText || '').includes(${q(name)})) return indexed;
        return rows.find((row) => (row.innerText || '').includes(${q(name)})) || null;
      })()
    `
    await this.client.waitForValue(`Boolean(${locator})`, {
      timeoutMs: 20_000,
      description: `project ${name}`
    })
    await this.client.evaluate(`
      (() => {
        const row = ${locator};
        if (!row) throw new Error('Project row disappeared');
        if (row.getAttribute('aria-expanded') !== 'true') row.click();
        return true;
      })()
    `)
    await sleep(250)
    await this.client.evaluate(`
      (() => {
        const row = ${locator};
        const root = row?.parentElement;
        const button = root?.querySelector(${q(SELECTORS.projectNewSession)});
        if (!button) throw new Error('New project conversation button is unavailable');
        button.click();
        return true;
      })()
    `)
    const opened = await this.client.waitForValue(
      `
        (() => {
          const row = ${locator};
          const composerReady = Boolean(document.querySelector(${q(SELECTORS.composerContent)}));
          if (row?.parentElement?.querySelector(${q(SELECTORS.activeSessionRow)}) && composerReady)
            return { status: 'ready' };
          // A new project conversation opens the home prompt with the project chosen; the
          // conversation itself is created by its first message.
          const home = document.querySelector(${q(SELECTORS.homePrompt)});
          const chosen = [...document.querySelectorAll("button")].some(
            (button) => (button.innerText || '').trim() === ${q(name)}
          );
          if (home && chosen && composerReady) return { status: 'ready' };
          const error = (window.__phiG4Probe?.peek?.() || []).find((event) => event.severity === 'error');
          return error ? { status: 'blocked', error: error.text } : null;
        })()
      `,
      { timeoutMs: 60_000, description: `new session in ${name}` }
    )
    if (opened.status === 'blocked') {
      const error = new Error(opened.error || `Unable to open a session in ${name}`)
      error.name = 'RemoteConnectionError'
      throw error
    }
    return this.snapshot()
  }

  async clickSelector(selector) {
    return this.client.evaluate(`
      (() => {
        const element = document.querySelector(${q(selector)});
        if (!element) throw new Error('Missing selector: ' + ${q(selector)});
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.click();
        return true;
      })()
    `)
  }

  async clickText(text, selector = 'button, [role="button"], [role="menuitem"]') {
    return this.client.evaluate(`
      (() => {
        const candidates = [...document.querySelectorAll(${q(selector)})];
        const element = candidates.find((item) => (item.innerText || item.textContent || '').trim() === ${q(text)});
        if (!element) throw new Error('Missing control with text: ' + ${q(text)});
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.click();
        return true;
      })()
    `)
  }

  async typePrompt(text) {
    await this.client.evaluate(`
      (() => {
        const editor = document.querySelector(${q(SELECTORS.composerContent)});
        if (!editor) throw new Error('Message editor is unavailable');
        editor.focus();
        return true;
      })()
    `)
    await dispatchSelectAllAndInsert(this.client, text)
    await this.client.waitForValue(
      `(() => (document.querySelector(${q(SELECTORS.composerContent)})?.textContent || '').includes(${q(text)}))()`,
      { timeoutMs: 5_000, description: 'composer text insertion' }
    )
  }

  async sendPrompt(text, options = {}) {
    const timeoutMs = options.timeoutMs ?? 240_000
    const observed = Object.fromEntries((options.observeSelectors ?? []).map((selector) => [selector, false]))
    const baseline = await this.snapshot()
    let assistantCount = baseline.session.assistants.length
    let errorCount = baseline.session.assistantErrors.length
    await this.typePrompt(text)
    await this.clickSelector(SELECTORS.send)
    await this.client.waitForValue(
      `
        (() => {
          const actions = [...document.querySelectorAll(${q(SELECTORS.userActions)})];
          const row = actions.at(-1)?.parentElement;
          return actions.length > ${baseline.users.length} && (row?.innerText || '').includes(${q(text)});
        })()
      `,
      { timeoutMs: 20_000, description: 'submitted user message' }
    )

    const deadline = Date.now() + timeoutMs
    let session
    while (Date.now() < deadline) {
      for (const selector of Object.keys(observed)) {
        if (!observed[selector]) {
          observed[selector] = Boolean(
            await this.client.evaluate(`document.querySelectorAll(${q(selector)}).length`)
          )
        }
      }
      if (process.env.G4_APPROVE === '1') await this.approvePendingTools()
      session = await this.sessionEvidence()
      const finished = await this.client.evaluate(`Boolean(document.querySelector(${q(SELECTORS.send)}))`)
      if (
        finished &&
        (session.assistants.length > assistantCount || session.assistantErrors.length > errorCount)
      ) {
        break
      }
      await sleep(300)
    }
    if (Date.now() >= deadline) {
      const error = new Error(`Model reply exceeded ${timeoutMs} ms`)
      error.name = 'TimeoutError'
      throw error
    }
    const snapshot = await this.snapshot()
    const newAssistants = snapshot.session.assistants.slice(assistantCount)
    const assistantText =
      [...newAssistants].reverse().find((item) => item.content.trim())?.content.trim() ||
      snapshot.assistantText.trim()
    return { baseline, snapshot, newAssistants, assistantText, observed }
  }

  /** Unattended runs answer every tool approval request with 批准. */
  async approvePendingTools() {
    return this.client.evaluate(`
      (() => {
        let clicked = 0;
        for (const card of document.querySelectorAll('[data-testid="gui-e2e-tool-approval"]')) {
          const approve = [...card.querySelectorAll('button')].find(
            (button) => (button.innerText || '').trim() === '批准'
          );
          if (approve && !approve.disabled) { approve.click(); clicked += 1; }
        }
        return clicked;
      })()
    `)
  }

  async waitForGenerationToFinish(timeoutMs = 240_000, stopAlreadyObserved = false) {
    if (!stopAlreadyObserved) {
      await this.client.waitForValue(`Boolean(document.querySelector(${q(SELECTORS.stop)}))`, {
        timeoutMs: Math.min(20_000, timeoutMs),
        intervalMs: 200,
        description: 'generation to enter streaming state'
      })
    }
    await this.client.waitForValue(`Boolean(document.querySelector(${q(SELECTORS.send)}))`, {
      timeoutMs,
      intervalMs: 400,
      description: 'generation to finish'
    })
  }

  async forkMessage(index) {
    return this.client.evaluate(`
      (() => {
        const buttons = [...document.querySelectorAll(${q(SELECTORS.fork)})];
        const button = buttons[${index}];
        if (!button) throw new Error('Fork button ' + ${index} + ' is unavailable');
        button.click();
        return buttons.length;
      })()
    `)
  }

  async currentSessionId() {
    return this.client.evaluate(`window.api.getCurrentSession().then((session) => session.phiSessionId || '')`)
  }

  /** Titles change (auto titles, forks), so a conversation is found again by its id. */
  async openSessionById(sessionId) {
    if ((await this.currentSessionId()) === sessionId) return this.snapshot()
    const title = await this.client.evaluate(`
      window.api.listSessions().then((sessions) => {
        const match = sessions.find((session) => (session.phiSessionId || session.id) === ${q(sessionId)});
        return match?.name || match?.firstMessage || '';
      })
    `)
    if (!title) throw new Error(`Session ${sessionId} is not listed`)
    return this.openSessionByTitle(title)
  }

  async openSessionByTitle(title) {
    await this.client.evaluate(`
      (() => {
        const shells = [...document.querySelectorAll('[data-phi-session-row-shell="true"]')];
        const shell = shells.find((item) => item.querySelector('.session-title')?.textContent?.trim() === ${q(title)});
        const row = shell?.querySelector('[data-phi-session-row]');
        if (!row) throw new Error('Session title is unavailable: ' + ${q(title)});
        row.click();
        return true;
      })()
    `)
    await this.client.waitForValue(
      `document.querySelector(${q(SELECTORS.activeSessionRow)})?.closest('[data-phi-session-row-shell="true"]')?.querySelector('.session-title')?.textContent?.trim() === ${q(title)}`,
      { timeoutMs: 30_000, description: `session ${title}` }
    )
    return this.snapshot()
  }

  async startPromptAndForkWhileStreaming(text, forkIndex) {
    const baseline = await this.snapshot()
    await this.typePrompt(text)
    const prepared = await this.client.evaluate(`
      (() => {
        const send = document.querySelector(${q(SELECTORS.send)});
        const forks = [...document.querySelectorAll(${q(SELECTORS.fork)})];
        const fork = forks[${forkIndex}];
        if (!send) throw new Error('Send button is unavailable');
        if (!fork) return { triggered: false, reason: 'fork control absent', forkCount: forks.length };
        const propsKey = Object.keys(fork).find((key) => key.startsWith('__reactProps$'));
        const onClick = propsKey ? fork[propsKey]?.onClick : null;
        if (typeof onClick !== 'function') {
          return { triggered: false, reason: 'fork UI handler unavailable', forkCount: forks.length };
        }
        window.__phiG4BusyForkAction = onClick;
        send.click();
        return { triggered: true, forkCount: forks.length, handler: 'captured React UI onClick' };
      })()
    `)
    if (!prepared.triggered) return { baseline, outcome: prepared, streamingObserved: false }
    await this.client.waitForValue(
      `document.querySelectorAll(${q(SELECTORS.userActions)}).length > ${baseline.users.length}`,
      { timeoutMs: 20_000, description: 'long-running prompt submission' }
    )
    await this.client.waitForValue(`Boolean(document.querySelector(${q(SELECTORS.stop)}))`, {
      timeoutMs: 20_000,
      intervalMs: 150,
      description: 'long-running prompt to begin streaming'
    })
    const outcome = await this.client.evaluate(`
      (() => {
        const action = window.__phiG4BusyForkAction;
        delete window.__phiG4BusyForkAction;
        if (typeof action !== 'function') {
          return { triggered: false, reason: 'captured fork UI handler disappeared' };
        }
        action();
        return { triggered: true, handler: 'captured React UI onClick', streamingObserved: true };
      })()
    `)
    return { baseline, outcome, streamingObserved: true }
  }

  async findNoticeContaining(text, timeoutMs = 15_000) {
    return this.client.waitForValue(
      `
        (() => {
          const probe = window.__phiG4Probe?.peek?.() || [];
          const event = probe.find((item) => item.text.includes(${q(text)}));
          if (event) return event;
          const nodes = [...document.querySelectorAll('.PhiSnackbar-card, [data-notice-level], [role="alert"]')];
          const node = nodes.find((item) => (item.innerText || item.textContent || '').includes(${q(text)}));
          return node ? { kind: 'visible', text: (node.innerText || node.textContent || '').trim() } : null;
        })()
      `,
      { timeoutMs, description: `notice containing “${text}”` }
    )
  }

  async findNoticeContainingOrNull(text, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = await this.client.evaluate(`
        (() => {
          const probe = window.__phiG4Probe?.peek?.() || [];
          const event = probe.find((item) => item.text.includes(${q(text)}));
          if (event) return event;
          const nodes = [...document.querySelectorAll('.PhiSnackbar-card, [data-notice-level], [role="alert"]')];
          const node = nodes.find((item) => (item.innerText || item.textContent || '').includes(${q(text)}));
          return node ? { kind: 'visible', text: (node.innerText || node.textContent || '').trim() } : null;
        })()
      `)
      if (found) return found
      await sleep(200)
    }
    return null
  }

  async inspectContextAndCompact(stepId) {
    await this.clickSelector(SELECTORS.contextUsage)
    await this.client.waitForValue(`Boolean(document.querySelector(${q(SELECTORS.contextPanel)}))`, {
      timeoutMs: 10_000,
      description: 'context usage panel'
    })
    const contextShot = path.join(this.run.shots, `${stepId}-context.png`)
    await this.client.screenshot(contextShot)
    const popoverHasCompaction = Boolean(
      await this.client.evaluate(`Boolean(document.querySelector(${q(SELECTORS.contextPanel)})?.querySelector(${q(SELECTORS.manualCompaction)}))`)
    )
    if (popoverHasCompaction) {
      await this.clickSelector(`${SELECTORS.contextPanel} ${SELECTORS.manualCompaction}`)
    } else {
      const close = 'button[aria-label="关闭上下文详情"]'
      if (await this.client.evaluate(`Boolean(document.querySelector(${q(close)}))`)) {
        await this.clickSelector(close)
      }
      await this.clickSelector(SELECTORS.settings)
      await this.client.waitForValue(`Boolean(document.querySelector('button[aria-label="关闭设置"]'))`, {
        timeoutMs: 10_000,
        description: 'settings dialog'
      })
      await this.clickText('通用', '[role="button"]')
      await this.client.waitForValue(`Boolean(document.querySelector(${q(SELECTORS.manualCompaction)}))`, {
        timeoutMs: 15_000,
        description: 'manual compaction control'
      })
      await this.client.waitForValue(
        `document.querySelector(${q(SELECTORS.manualCompaction)})?.disabled === false`,
        { timeoutMs: 30_000, description: 'manual compaction control to become enabled' }
      )
      await this.clickSelector(SELECTORS.manualCompaction)
    }
    const success = await this.findNoticeContaining('上下文已压缩', 120_000)
    if (await this.client.evaluate(`Boolean(document.querySelector('button[aria-label="关闭设置"]'))`)) {
      await this.clickSelector('button[aria-label="关闭设置"]')
    }
    return {
      route: popoverHasCompaction ? 'context-usage popover' : 'context-usage inspection → 设置 → 通用',
      contextShot,
      success
    }
  }

  async switchToDifferentModel() {
    const before = await this.currentModel()
    await this.clickSelector(SELECTORS.model)
    await this.client.waitForValue(`Boolean(document.querySelector('input[placeholder="搜索模型"]'))`, {
      timeoutMs: 10_000,
      description: 'model menu'
    })
    const providers = await this.client.evaluate(`
      [...document.querySelectorAll('.MuiPopover-paper .MuiAccordionSummary-root')]
        .map((item, index) => ({ index, text: (item.innerText || '').trim() }))
    `)
    const seenOptions = []
    let candidate = null
    for (const provider of providers) {
      await this.client.evaluate(`
        (() => {
          const items = [...document.querySelectorAll('.MuiPopover-paper .MuiAccordionSummary-root')];
          const item = items[${provider.index}];
          if (item?.getAttribute('aria-expanded') !== 'true') item?.click();
          return true;
        })()
      `)
      await sleep(200)
      const options = await this.client.evaluate(`
        (() => {
          const summaries = [...document.querySelectorAll('.MuiPopover-paper .MuiAccordionSummary-root')];
          const root = summaries[${provider.index}]?.closest('.MuiAccordion-root');
          return [...(root?.querySelectorAll('.MuiAccordionDetails-root .MuiListItemButton-root') || [])]
            .map((item, index) => ({ index, text: (item.innerText || '').trim(), selected: item.classList.contains('Mui-selected') }));
        })()
      `)
      for (const option of options) seenOptions.push(`${provider.text}/${option.text}`)
      const option = options.find((item) => !item.selected)
      if (!candidate && option) candidate = { provider, option }
    }
    let selected = null
    if (candidate) {
      const wasGenerating = Boolean(
        await this.client.evaluate(`Boolean(document.querySelector(${q(SELECTORS.stop)}))`)
      )
      selected = { provider: candidate.provider.text, wasGenerating, ...candidate.option }
      await this.client.evaluate(`
        (() => {
          const summaries = [...document.querySelectorAll('.MuiPopover-paper .MuiAccordionSummary-root')];
          const summary = summaries[${candidate.provider.index}];
          if (summary?.getAttribute('aria-expanded') !== 'true') summary?.click();
          const root = summary?.closest('.MuiAccordion-root');
          const items = [...(root?.querySelectorAll('.MuiAccordionDetails-root .MuiListItemButton-root') || [])];
          items[${candidate.option.index}]?.click();
          return true;
        })()
      `)
    }
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 0
    })
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 0
    })
    if (!selected) return { changed: false, before, available: [...new Set(seenOptions)] }
    await this.client.waitForValue(
      `document.querySelector(${q(SELECTORS.model)})?.getAttribute('aria-label') !== ${q(before?.ariaLabel ?? '')}`,
      { timeoutMs: 20_000, description: 'model selection to change' }
    )
    return {
      changed: true,
      before,
      selected: `${selected.provider}/${selected.text}`,
      streamingAtSelection: selected.wasGenerating,
      after: await this.currentModel(),
      available: [...new Set(seenOptions)]
    }
  }

  currentModel() {
    return this.client.evaluate(`
      (() => {
        const element = document.querySelector(${q(SELECTORS.model)});
        return element ? { text: (element.innerText || '').trim(), ariaLabel: element.getAttribute('aria-label') || '' } : null;
      })()
    `)
  }

  async verifyDryRunSelectors(projectName) {
    const home = await this.client.evaluate(`({
      settings: Boolean(document.querySelector(${q(SELECTORS.settings)})),
      conversationsNavigation: Boolean(document.querySelector(${q(SELECTORS.conversationsNavigation)})),
      projectsNavigation: Boolean(document.querySelector(${q(SELECTORS.projectsNavigation)})),
      homePrompt: Boolean(document.querySelector(${q(SELECTORS.homePrompt)})),
      windowApi: Boolean(window.api?.createProject && window.api?.getCurrentSession)
    })`)
    await this.openNewProjectSession(projectName)
    const session = await this.client.evaluate(`({
      projectRow: Boolean(document.querySelector(${q(SELECTORS.projectRow)})),
      projectNewSession: Boolean(document.querySelector(${q(SELECTORS.projectNewSession)})),
      activeSessionRow: Boolean(document.querySelector(${q(SELECTORS.activeSessionRow)})),
      composer: Boolean(document.querySelector(${q(SELECTORS.composerContent)})),
      send: Boolean(document.querySelector(${q(SELECTORS.send)})),
      model: Boolean(document.querySelector(${q(SELECTORS.model)})),
      contextUsage: Boolean(document.querySelector(${q(SELECTORS.contextUsage)})),
      settings: Boolean(document.querySelector(${q(SELECTORS.settings)}))
    })`)
    await this.clickSelector(SELECTORS.contextUsage)
    await this.client.waitForValue(`Boolean(document.querySelector(${q(SELECTORS.contextPanel)}))`, {
      timeoutMs: 10_000,
      description: 'dry-run context panel'
    })
    session.contextPanel = true
    await this.clickSelector('button[aria-label="关闭上下文详情"]')

    await this.clickSelector(SELECTORS.settings)
    await this.client.waitForValue(`Boolean(document.querySelector('button[aria-label="关闭设置"]'))`, {
      timeoutMs: 10_000,
      description: 'dry-run settings dialog'
    })
    await this.clickText('通用', '[role="button"]')
    await this.client.waitForValue(`Boolean(document.querySelector(${q(SELECTORS.manualCompaction)}))`, {
      timeoutMs: 15_000,
      description: 'dry-run manual compaction control'
    })
    session.manualCompaction = true
    await this.clickSelector('button[aria-label="关闭设置"]')

    await this.clickSelector(SELECTORS.model)
    await this.client.waitForValue(
      `Boolean(document.querySelector('input[placeholder="搜索模型"]'))`,
      { timeoutMs: 10_000, description: 'dry-run model menu' }
    )
    session.modelSearch = true
    session.modelProviderGroups = Boolean(
      await this.client.evaluate(
        `document.querySelectorAll('.MuiPopover-paper .MuiAccordionSummary-root').length`
      )
    )
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 0
    })
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 0
    })
    await this.client.waitForValue(
      `!document.querySelector('input[placeholder="搜索模型"]')`,
      { timeoutMs: 5_000, description: 'dry-run model menu to close' }
    )
    return {
      home,
      session,
      conditional: {
        fork: '仅在已有且空闲的本地用户消息上渲染；dry-run 不发送提示词',
        childRun: '仅在模型委派子智能体后渲染；dry-run 不调用模型',
        errorNotice: '仅在错误时渲染'
      }
    }
  }
}
