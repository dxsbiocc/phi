import type { WebContents } from 'electron'
import { BROWSER_MAX_TEXT_BYTES } from '../../shared/browserTypes'
import type { EngineResult, EngineTabState, EngineTargetInspection } from './browser-engine'
import {
  readElectronBrowserViewBounds,
  sameElectronBrowserViewBounds,
  type ElectronBrowserInputTarget
} from './electron-browser-input'
import { authorizeBrowserTarget, validatedBrowserTargetInspection } from './browser-target-policy'

export const PHI_BROWSER_INSPECTION_WORLD_ID = 1001

type BrowserFrameLike = {
  frameTreeNodeId: number
  isDestroyed(): boolean
}

export type ElectronBrowserTargetWebContents = {
  focus?: WebContents['focus']
  insertText?: WebContents['insertText']
  executeJavaScriptInIsolatedWorld?: WebContents['executeJavaScriptInIsolatedWorld']
  readonly mainFrame?: BrowserFrameLike
  readonly focusedFrame?: BrowserFrameLike | null
}

export type ElectronBrowserTarget = ElectronBrowserInputTarget & {
  view: ElectronBrowserInputTarget['view'] & {
    webContents: ElectronBrowserInputTarget['view']['webContents'] &
      ElectronBrowserTargetWebContents
  }
}

type TargetSelector = { target: 'focused' } | { target: 'point'; x: number; y: number }

const INSPECTOR_PREFIX = String.raw`(() => {
  'use strict';
  const rawTarget = `

const INSPECTOR_SUFFIX = String.raw`;
  if (!(rawTarget instanceof Element)) return null;
  let candidate = rawTarget.closest('button,input,textarea,a,label,[contenteditable]') || rawTarget;
  if (candidate instanceof HTMLLabelElement && candidate.control instanceof HTMLElement) {
    candidate = candidate.control;
  }
  if (!(candidate instanceof HTMLElement)) return null;
  if (candidate.getRootNode() !== document || candidate.tagName.includes('-')) return null;
  if (candidate instanceof HTMLIFrameElement ||
      candidate instanceof HTMLObjectElement ||
      candidate instanceof HTMLEmbedElement ||
      candidate.tagName === 'FRAME' ||
      candidate.tagName === 'WEBVIEW') {
    return {
      descriptor: {
        tagName: candidate.tagName,
        editable: false,
        submitsForm: false
      },
      fingerprint: 'target-1'
    };
  }

  const normalizeToken = (value, max) => {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    return normalized && normalized.length <= max && /^[a-z0-9-]+$/.test(normalized)
      ? normalized
      : undefined;
  };
  const normalizeLabel = (value) => {
    if (typeof value !== 'string') return undefined;
    const normalized = value
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return normalized ? normalized.slice(0, 256) : undefined;
  };

  const tagName = candidate.tagName;
  const rawType = normalizeToken(candidate.getAttribute('type'), 32);
  const autocomplete = String(candidate.getAttribute('autocomplete') || '')
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  let inputType;
  if (candidate instanceof HTMLInputElement) {
    if (autocomplete.includes('one-time-code') || rawType === 'otp' || rawType === 'one-time-code') {
      inputType = 'one-time-code';
    } else if (autocomplete.includes('current-password') || autocomplete.includes('new-password')) {
      inputType = 'password';
    } else {
      inputType = normalizeToken(candidate.type, 32);
    }
  } else if (candidate.isContentEditable) {
    inputType = 'contenteditable';
  }

  const textInputTypes = new Set([
    'text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local',
    'month', 'time', 'week'
  ]);
  const editable = candidate instanceof HTMLInputElement
    ? !candidate.disabled && !candidate.readOnly && !!inputType && textInputTypes.has(inputType)
    : candidate instanceof HTMLTextAreaElement
      ? !candidate.disabled && !candidate.readOnly
      : candidate.isContentEditable;

  const form = 'form' in candidate && candidate.form instanceof HTMLFormElement
    ? candidate.form
    : candidate.closest('form');
  let formAction;
  let formMethod;
  if (form instanceof HTMLFormElement) {
    const submitterMethod = candidate instanceof HTMLButtonElement || candidate instanceof HTMLInputElement
      ? candidate.getAttribute('formmethod')
      : null;
    const submitterAction = candidate instanceof HTMLButtonElement || candidate instanceof HTMLInputElement
      ? candidate.getAttribute('formaction')
      : null;
    formMethod = normalizeToken(submitterMethod || form.method || 'get', 16);
    try {
      const action = new URL(submitterAction || form.action || location.href, location.href);
      action.username = '';
      action.password = '';
      action.search = '';
      action.hash = '';
      if (action.protocol === 'http:' || action.protocol === 'https:') formAction = action.toString();
    } catch {
      return null;
    }
  }
  const submitsForm = !!form && (
    (candidate instanceof HTMLButtonElement && (candidate.type || 'submit') === 'submit') ||
    (candidate instanceof HTMLInputElement && (inputType === 'submit' || inputType === 'image'))
  );

  const descriptor = {
    tagName,
    ...(inputType ? { inputType } : {}),
    ...(normalizeToken(candidate.getAttribute('role'), 64)
      ? { role: normalizeToken(candidate.getAttribute('role'), 64) }
      : {}),
    ...(normalizeLabel(candidate.getAttribute('aria-label'))
      ? { accessibleLabel: normalizeLabel(candidate.getAttribute('aria-label')) }
      : {}),
    ...(formMethod ? { formMethod } : {}),
    ...(formAction ? { formAction } : {}),
    editable,
    submitsForm
  };

  const stateKey = '__phiBrowserTargetInspectionV1__';
  let state = globalThis[stateKey];
  if (!state || !(state.targets instanceof WeakMap) || !Number.isSafeInteger(state.nextId)) {
    state = { targets: new WeakMap(), nextId: 0 };
    Object.defineProperty(globalThis, stateKey, {
      value: state,
      configurable: false,
      enumerable: false,
      writable: false
    });
  }
  let id = state.targets.get(candidate);
  if (!Number.isSafeInteger(id) || id <= 0) {
    id = ++state.nextId;
    state.targets.set(candidate, id);
  }
  return { descriptor, fingerprint: 'target-' + String(id) };
})()`

export const FOCUSED_TARGET_INSPECTION_SOURCE =
  INSPECTOR_PREFIX + 'document.activeElement' + INSPECTOR_SUFFIX

export function pointTargetInspectionSource(x: number, y: number): string | null {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) return null
  return (
    INSPECTOR_PREFIX + `document.elementFromPoint(${String(x)}, ${String(y)})` + INSPECTOR_SUFFIX
  )
}

function frameIsCurrentMain(webContents: ElectronBrowserTargetWebContents): boolean {
  const main = webContents.mainFrame
  const focused = webContents.focusedFrame
  if (!main || !focused || !Number.isSafeInteger(main.frameTreeNodeId)) return false
  try {
    return (
      !main.isDestroyed() &&
      !focused.isDestroyed() &&
      main.frameTreeNodeId === focused.frameTreeNodeId
    )
  } catch {
    return false
  }
}

function unavailable(): EngineResult {
  return {
    ok: false,
    error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Browser target inspection is unavailable' }
  }
}

function stale(): EngineResult {
  return {
    ok: false,
    error: { code: 'STALE_DOCUMENT', message: 'Browser screenshot is stale' }
  }
}

function cancelled(): EngineResult {
  return {
    ok: false,
    error: { code: 'ACTION_CANCELLED', message: 'Browser action was cancelled' }
  }
}

function contextReady(
  target: ElectronBrowserTarget,
  expectedDocumentRevision: number,
  signal?: AbortSignal
): EngineResult | null {
  if (signal?.aborted) return cancelled()
  const screenshot = target.latestScreenshot
  if (
    !screenshot ||
    target.state.isLoading ||
    target.state.documentRevision !== expectedDocumentRevision ||
    screenshot.documentRevision !== expectedDocumentRevision
  ) {
    return stale()
  }
  if (
    !target.presented ||
    target.window.isMinimized() ||
    !target.window.isVisible() ||
    target.window.isFocused?.() !== true ||
    typeof target.view.webContents.focus !== 'function' ||
    typeof target.view.webContents.executeJavaScriptInIsolatedWorld !== 'function' ||
    !frameIsCurrentMain(target.view.webContents)
  ) {
    return unavailable()
  }
  const bounds = readElectronBrowserViewBounds(target)
  if (!bounds || !sameElectronBrowserViewBounds(bounds, screenshot.bounds)) {
    target.latestScreenshot = undefined
    return stale()
  }
  return null
}

function parsedInspection(value: unknown, state: EngineTabState): EngineResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return unavailable()
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, 'descriptor') ||
    !Object.hasOwn(record, 'fingerprint')
  ) {
    return unavailable()
  }
  const candidate: EngineResult = {
    ok: true,
    state: { ...state },
    target: record.descriptor as never,
    targetFingerprint: record.fingerprint as never
  }
  const inspection = validatedBrowserTargetInspection(candidate)
  return inspection
    ? {
        ok: true,
        state: { ...state },
        target: inspection.descriptor,
        targetFingerprint: inspection.fingerprint
      }
    : unavailable()
}

export async function inspectElectronBrowserTarget(
  target: ElectronBrowserTarget,
  selector: TargetSelector,
  expectedDocumentRevision: number,
  signal?: AbortSignal
): Promise<EngineResult> {
  const initial = contextReady(target, expectedDocumentRevision, signal)
  if (initial) return initial
  try {
    target.view.webContents.focus?.()
  } catch {
    return unavailable()
  }
  const prepared = contextReady(target, expectedDocumentRevision, signal)
  if (prepared) return prepared
  const screenshot = target.latestScreenshot
  const bounds = readElectronBrowserViewBounds(target)
  if (!screenshot || !bounds) return stale()

  let source = FOCUSED_TARGET_INSPECTION_SOURCE
  if (selector.target === 'point') {
    if (
      !Number.isFinite(selector.x) ||
      selector.x < 0 ||
      selector.x >= screenshot.width ||
      !Number.isFinite(selector.y) ||
      selector.y < 0 ||
      selector.y >= screenshot.height
    ) {
      return stale()
    }
    const x = Math.floor((selector.x * bounds.width) / screenshot.width)
    const y = Math.floor((selector.y * bounds.height) / screenshot.height)
    source = pointTargetInspectionSource(x, y) ?? ''
    if (!source) return unavailable()
  }

  try {
    const value = await target.view.webContents.executeJavaScriptInIsolatedWorld?.(
      PHI_BROWSER_INSPECTION_WORLD_ID,
      [{ code: source }],
      false
    )
    const after = contextReady(target, expectedDocumentRevision, signal)
    if (after) return after
    return parsedInspection(value, target.state)
  } catch {
    return signal?.aborted ? cancelled() : unavailable()
  }
}

function sameInspection(
  expected: EngineTargetInspection,
  actual: EngineResult
): actual is Extract<EngineResult, { ok: true }> {
  if (
    typeof expected !== 'object' ||
    expected === null ||
    Array.isArray(expected) ||
    Object.keys(expected).sort().join(',') !== 'descriptor,fingerprint'
  ) {
    return false
  }
  const normalized = validatedBrowserTargetInspection({
    ok: true,
    state: actual.ok ? actual.state : ({} as EngineTabState),
    target: expected.descriptor,
    targetFingerprint: expected.fingerprint
  })
  return (
    normalized !== null &&
    actual.ok &&
    actual.targetFingerprint === normalized.fingerprint &&
    JSON.stringify(actual.target) === JSON.stringify(normalized.descriptor)
  )
}

export async function verifyElectronBrowserTarget(options: {
  target: ElectronBrowserTarget
  selector: TargetSelector
  expectedDocumentRevision: number
  expectedTarget?: EngineTargetInspection
  signal?: AbortSignal
}): Promise<EngineResult> {
  const inspected = await inspectElectronBrowserTarget(
    options.target,
    options.selector,
    options.expectedDocumentRevision,
    options.signal
  )
  if (!options.expectedTarget) return inspected.ok ? unavailable() : inspected
  return sameInspection(options.expectedTarget, inspected) ? inspected : stale()
}

export async function executeElectronBrowserTextInput(options: {
  target: ElectronBrowserTarget
  text: string
  expectedDocumentRevision: number
  expectedTarget?: EngineTargetInspection
  signal?: AbortSignal
}): Promise<EngineResult> {
  if (
    typeof options.text !== 'string' ||
    options.text.length === 0 ||
    Buffer.byteLength(options.text, 'utf8') > BROWSER_MAX_TEXT_BYTES ||
    typeof options.target.view.webContents.insertText !== 'function'
  ) {
    return unavailable()
  }
  const verified = await verifyElectronBrowserTarget({
    target: options.target,
    selector: { target: 'focused' },
    expectedDocumentRevision: options.expectedDocumentRevision,
    expectedTarget: options.expectedTarget,
    signal: options.signal
  })
  if (!verified.ok) return verified
  const targetInspection = validatedBrowserTargetInspection(verified)
  if (!targetInspection) return unavailable()
  const targetAccess = authorizeBrowserTarget({
    action: 'typeText',
    tabId: '',
    inspection: targetInspection
  })
  if (!targetAccess.ok) {
    return {
      ok: false,
      error: { code: targetAccess.error.code, message: 'Browser text input was not permitted' }
    }
  }
  const finalContext = contextReady(
    options.target,
    options.expectedDocumentRevision,
    options.signal
  )
  if (finalContext) return finalContext

  options.target.latestScreenshot = undefined
  let delivery: Promise<void>
  try {
    delivery = Promise.resolve(options.target.view.webContents.insertText(options.text))
  } catch {
    return {
      ok: false,
      error: { code: 'ACTION_TIMEOUT', message: 'Browser text delivery may be incomplete' }
    }
  }
  const delivered = delivery.then(
    () => true,
    () => false
  )
  let abortedDuringDelivery = options.signal?.aborted ?? false
  const onAbort = (): void => {
    abortedDuringDelivery = true
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const didDeliver = await delivered
  options.signal?.removeEventListener('abort', onAbort)
  if (!didDeliver) {
    return {
      ok: false,
      error: {
        code: abortedDuringDelivery ? 'ACTION_CANCELLED' : 'ACTION_TIMEOUT',
        message: 'Browser text delivery may be incomplete'
      }
    }
  }
  if (
    abortedDuringDelivery ||
    options.target.state.isLoading ||
    options.target.state.documentRevision !== options.expectedDocumentRevision
  ) {
    return {
      ok: false,
      error: {
        code: options.signal?.aborted ? 'ACTION_CANCELLED' : 'ACTION_TIMEOUT',
        message: 'Browser text delivery may be incomplete'
      }
    }
  }
  return { ok: true, state: { ...options.target.state } }
}
