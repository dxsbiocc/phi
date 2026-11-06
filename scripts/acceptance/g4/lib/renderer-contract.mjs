export const SELECTORS = Object.freeze({
  settings: 'button[aria-label="设置"]',
  conversationsNavigation: 'button[aria-label="对话"]',
  projectsNavigation: 'button[aria-label="项目"]',
  homePrompt: '[data-phi-home-prompt="true"]',
  projectRow: '[data-phi-project-row="true"]',
  projectNewSession: 'button[aria-label="新建项目对话"]',
  sessionRow: '[data-phi-session-row]',
  activeSessionRow: '[data-phi-session-row="active"]',
  composer: '[data-phi-composer-editor="codemirror"]',
  composerContent: '[data-phi-composer-editor="codemirror"] .cm-content[contenteditable="true"]',
  send: '[data-phi-composer-action="send"]',
  stop: '[data-phi-composer-action="stop"]',
  model: '[data-phi-model-thinking="true"]',
  contextUsage: '[data-phi-context-usage]',
  contextPanel: '[data-phi-context-breakdown-panel="true"]',
  fork: 'button[aria-label="从此消息分叉会话"]',
  userActions: '[data-phi-user-message-actions="true"]',
  childRun: '[data-agent-card-id], button[aria-label*="Agent 运行中"]',
  errorNotice: '[data-notice-level="error"]',
  snackbar: '.PhiSnackbar-card',
  manualCompaction: 'button[aria-label="压缩当前会话上下文"]'
})

export const PROBE_SCRIPT = String.raw`
(() => {
  if (window.__phiG4Probe) return true;
  let signatures = new WeakMap();
  const state = { activeStep: null, events: [] };
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const record = (element, kind, severity) => {
    if (!visible(element)) return;
    const text = (element.innerText || element.textContent || '').trim();
    const signature = kind + '|' + severity + '|' + text;
    if (signatures.get(element) === signature) return;
    signatures.set(element, signature);
    if (state.activeStep) {
      state.events.push({ at: new Date().toISOString(), kind, severity, text });
    }
  };
  const scan = () => {
    for (const card of document.querySelectorAll('.PhiSnackbar-card')) {
      const iconLabel = card.querySelector('[role="img"]')?.getAttribute('aria-label') || '';
      const severity = /错误|error/i.test(iconLabel) ? 'error' :
        /警告|warning/i.test(iconLabel) ? 'warning' :
        /成功|success/i.test(iconLabel) ? 'success' : 'info';
      record(card, 'snackbar', severity);
    }
    for (const notice of document.querySelectorAll('[data-notice-level="error"]')) {
      record(notice, 'timeline-notice', 'error');
    }
    for (const alert of document.querySelectorAll('[role="alert"]')) {
      if (alert.closest('.PhiSnackbar-card') || alert.matches('[data-notice-level]')) continue;
      // A tool approval request is announced as an alert but is a question, not an error.
      if (alert.matches('[data-testid="gui-e2e-tool-approval"]')) continue;
      const classes = String(alert.className || '');
      const text = (alert.innerText || alert.textContent || '').trim();
      const muiNonError = /MuiAlert-(?:standard|filled|outlined)?(?:Warning|Info|Success)|MuiAlert-color(?:Warning|Info|Success)/.test(classes);
      const explicitError = /MuiAlert-(?:standard|filled|outlined)?Error|MuiAlert-colorError/.test(classes);
      const compactionError = /上下文压缩失败|Context compaction failed/i.test(text);
      if (!muiNonError && (explicitError || compactionError || !/MuiAlert-root/.test(classes))) {
        record(alert, 'alert', 'error');
      }
    }
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'role', 'data-notice-level', 'aria-label']
  });
  scan();
  window.__phiG4Probe = {
    start(id) {
      state.activeStep = id;
      state.events = [];
      signatures = new WeakMap();
      scan();
      return true;
    },
    finish() {
      scan();
      const result = state.events.slice();
      state.activeStep = null;
      state.events = [];
      return result;
    },
    peek() {
      scan();
      return state.events.slice();
    }
  };
  return true;
})()
`

export const SESSION_EVIDENCE_SCRIPT = String.raw`
(async () => {
  const session = await window.api.getCurrentSession();
  const text = (message) => {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) =>
      typeof part === 'string' ? part :
      typeof part?.text === 'string' ? part.text :
      typeof part?.content === 'string' ? part.content : ''
    ).filter(Boolean).join('\n');
    if (typeof message?.text === 'string') return message.text;
    return '';
  };
  const assistants = [];
  const users = [];
  const assistantErrors = [];
  const messages = session.messages || [];
  const preferPhiTimeline = messages.some((raw) => raw?.source === 'phi' && raw?.preferPhiTimeline === true);
  for (const [index, raw] of messages.entries()) {
    const nested = raw?.message && typeof raw.message === 'object' ? raw.message : null;
    const message = nested?.role ? nested : raw;
    const role = message?.role ??
      (raw?.type === 'user_message' ? 'user' :
        raw?.type === 'assistant_message_finalized' ? 'assistant' : undefined);
    const stopReason = message?.stopReason ?? raw?.stopReason;
    const content = text(message);
    const identity = raw?.eventId ?? raw?.id ?? message?.id ?? raw?.createdAt ?? message?.createdAt;
    const id = String(identity ?? index);
    const runId = String(raw?.runId ?? message?.runId ?? '');
    const entry = {
      key: identity ? 'id:' + id + ':' + runId : 'index:' + index + ':' + runId,
      id,
      runId,
      content,
      stopReason: stopReason ?? null
    };
    if (preferPhiTimeline && raw?.source !== 'phi' && (role === 'user' || role === 'assistant')) {
      if (role === 'assistant' && stopReason === 'error') {
        assistantErrors.push({
          ...entry,
          errorMessage: String(message?.errorMessage ?? raw?.errorMessage ?? '')
        });
      }
      continue;
    }
    if (role === 'assistant') {
      assistants.push(entry);
      if (stopReason === 'error') {
        assistantErrors.push({
          ...entry,
          errorMessage: String(message?.errorMessage ?? raw?.errorMessage ?? '')
        });
      }
    } else if (role === 'user') {
      users.push(entry);
    }
  }
  return {
    path: session.path ?? null,
    phiSessionId: session.phiSessionId ?? null,
    sessionGeneration: session.sessionGeneration ?? null,
    assistants,
    users,
    assistantErrors
  };
})()
`

export const DOM_SNAPSHOT_SCRIPT = String.raw`
(() => {
  const actionNodes = [...document.querySelectorAll('[data-phi-user-message-actions="true"]')];
  const userRows = actionNodes.map((actions) => actions.parentElement).filter(Boolean);
  const users = userRows.map((row) => (row.innerText || '').trim());
  const lastUserRow = userRows.at(-1)?.parentElement || null;
  const list = lastUserRow?.parentElement || null;
  const rowsAfterLastUser = lastUserRow && list
    ? [...list.children].slice([...list.children].indexOf(lastUserRow) + 1)
    : [];
  const assistantRows = rowsAfterLastUser.filter((row) =>
    !row.querySelector('[data-phi-user-message-actions]') &&
    !row.querySelector('[data-phi-outer-fold-chevron]') &&
    !row.querySelector('[data-agent-card-id]') &&
    !row.querySelector('[data-notice-level]') &&
    !row.querySelector('[role="alert"]')
  );
  const assistantText = assistantRows
    .map((row) => (row.innerText || '').trim())
    .filter(Boolean)
    .join('\n');
  const active = document.querySelector('[data-phi-session-row="active"]');
  const title = active?.closest('[data-phi-session-row-shell="true"]')
    ?.querySelector('.session-title')?.textContent?.trim() || '';
  const model = document.querySelector('[data-phi-model-thinking="true"]');
  const notices = [...document.querySelectorAll('.PhiSnackbar-card, [data-notice-level], [role="alert"]')]
    .filter((element) => getComputedStyle(element).display !== 'none')
    .map((element) => (element.innerText || element.textContent || '').trim())
    .filter(Boolean);
  return {
    users,
    assistantText,
    activeSessionTitle: title,
    forkButtonCount: document.querySelectorAll('button[aria-label="从此消息分叉会话"]').length,
    childRunCount: document.querySelectorAll('[data-agent-card-id]').length,
    generating: Boolean(document.querySelector('[data-phi-composer-action="stop"]')),
    model: model ? { text: (model.innerText || '').trim(), ariaLabel: model.getAttribute('aria-label') || '' } : null,
    notices
  };
})()
`
