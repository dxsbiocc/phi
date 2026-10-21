import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider, Switch } from '@mui/material'
import {
  ProviderCard,
  type ProviderCardProps
} from '../src/renderer/src/features/settings/components/ProviderCard'
import { ProviderModelList } from '../src/renderer/src/features/settings/components/ProviderModelList'
import {
  filterProviders,
  filterProviderModels,
  providerCapabilityLabel
} from '../src/renderer/src/features/settings/lib/providerCapabilities'
import { providerManagementUi } from '../src/renderer/src/features/settings/lib/providerManagementUi'
import {
  availabilityTarget,
  type AvailabilityState
} from '../src/renderer/src/features/settings/lib/modelAvailabilityController'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { componentTree } from './helpers/renderComponentTree'
import type { ProviderAuthStatus } from '../src/renderer/src/types'
import type {
  ModelAvailabilityChange,
  ModelAvailabilitySnapshot
} from '../src/shared/modelAvailabilityTypes'

const provider: ProviderAuthStatus = {
  providerId: 'typesafe',
  name: 'TypeSafe',
  configured: true,
  hasApiKey: true,
  hasOAuth: false,
  hasConfigError: false,
  statusText: 'stored',
  modelKinds: ['decision']
}
const snapshot: ModelAvailabilitySnapshot = {
  disabledProviders: [],
  disabledModels: [],
  models: [
    {
      providerId: 'typesafe',
      modelId: 'jev-test',
      name: 'JEV test',
      kind: 'decision',
      configured: true,
      enabled: true
    }
  ]
}
const state: AvailabilityState = {
  snapshot,
  loading: false,
  loadError: null,
  errors: {},
  pending: []
}
const base: ProviderCardProps = {
  provider,
  state,
  onLogout: () => undefined,
  onChange: () => undefined
}
const render = (element: ReactElement): string =>
  renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
afterEach(() => setUiLanguage('en'))

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}

test('provider cards keep credentials/logout separate and integrate automatic decisions without an independent picker', () => {
  const markup = render(createElement(ProviderCard, base))
  assert.match(markup, /TypeSafe/)
  assert.match(markup, /Enable TypeSafe provider/)
  assert.match(markup, /API Key/)
  assert.match(markup, /Configured/)
  assert.match(markup, /data-phi-provider-icon="typesafe"/)
  assert.match(markup, /JEV/)
  assert.doesNotMatch(markup, /automatically uses an enabled decision model/)
  assert.match(markup, /Models \(1\)/)
  assert.doesNotMatch(markup, />typesafe</)
  assert.doesNotMatch(markup, /Saved credentials/)
  assert.doesNotMatch(markup, />Chat</)
  assert.doesNotMatch(markup, /Model for decisions|Use current conversation model|>Save</)
  const chatMarkup = render(
    createElement(ProviderCard, {
      ...base,
      provider: {
        ...provider,
        providerId: 'deepseek',
        name: 'DeepSeek',
        modelKinds: ['chat'],
        statusText: 'stored'
      },
      state: { ...state, snapshot: { ...snapshot, models: [] } }
    })
  )
  assert.match(chatMarkup, /data-phi-provider-icon="deepseek"/)
  assert.match(chatMarkup, /Configured/)
  assert.doesNotMatch(chatMarkup, /Saved credentials/)
  assert.doesNotMatch(chatMarkup, />Chat</)
  assert.doesNotMatch(chatMarkup, />deepseek</)
  const disabled = render(
    createElement(ProviderCard, {
      ...base,
      state: { ...state, snapshot: { ...snapshot, disabledProviders: ['typesafe'] } }
    })
  )
  assert.match(disabled, /Credentials are kept/)
  assert.match(disabled, /Log out/)
})

test('provider and model switches send only reversible availability changes, leaving logout untouched', () => {
  const changes: ModelAvailabilityChange[] = []
  let logouts = 0
  const tree = componentTree(() =>
    ProviderCard({
      ...base,
      onChange: (change) => changes.push(change),
      onLogout: () => {
        logouts += 1
      }
    })
  )
  const header = elements(tree).find(
    (node) => typeof node.type === 'function' && node.type.name === 'ProviderHeader'
  )
  assert.ok(header)
  const headerTree = componentTree(() =>
    (header.type as (props: unknown) => ReactElement)(header.props)
  )
  const toggle = elements(headerTree).find((node) => node.type === Switch)
  assert.ok(toggle)
  ;(toggle.props.onChange as (event: unknown, checked: boolean) => void)({}, false)
  assert.deepEqual(changes, [{ providerId: 'typesafe', enabled: false }])
  assert.equal(logouts, 0)
  const list = componentTree(() =>
    ProviderModelList({
      models: snapshot.models,
      state,
      providerEnabled: true,
      onChange: (change) => changes.push(change)
    })
  )
  const row = elements(list).find(
    (node) => typeof node.type === 'function' && node.type.name === 'ModelRow'
  )
  assert.ok(row)
  const rowTree = componentTree(() => (row.type as (props: unknown) => ReactElement)(row.props))
  const modelToggle = elements(rowTree).find((node) => node.type === Switch)
  assert.ok(modelToggle)
  ;(modelToggle.props.onChange as (event: unknown, checked: boolean) => void)({}, false)
  assert.deepEqual(changes[1], { providerId: 'typesafe', modelId: 'jev-test', enabled: false })
})

test('model names stay on one scrollable line and chat models are not labeled as chat', () => {
  const models = [
    {
      providerId: 'cursor',
      modelId: 'claude-4-sonnet',
      name: 'Claude Sonnet 4',
      kind: 'chat' as const,
      configured: true,
      enabled: true
    },
    snapshot.models[0]
  ]
  const markup = render(
    createElement(ProviderModelList, {
      models,
      state: { ...state, snapshot: { ...snapshot, models } },
      providerEnabled: true,
      onChange: () => undefined
    })
  )
  assert.match(markup, /role="list"/)
  assert.match(markup, /Claude Sonnet 4/)
  assert.match(markup, /title="claude-4-sonnet"/)
  assert.doesNotMatch(markup, />claude-4-sonnet</)
  assert.doesNotMatch(markup, />Chat</)
  assert.match(markup, /Decision · JEV/)
  assert.doesNotMatch(markup, /Show more/)
})

test('provider disable keeps each model preference checked but blocks use until reenabled', () => {
  const disabled: AvailabilityState = {
    ...state,
    snapshot: {
      ...snapshot,
      disabledProviders: ['typesafe'],
      models: snapshot.models.map((model) => ({ ...model, enabled: false }))
    }
  }
  const markup = render(
    createElement(ProviderModelList, {
      models: snapshot.models,
      state: disabled,
      providerEnabled: false,
      onChange: () => undefined
    })
  )
  const input = markup.match(/<input[^>]*aria-label="Enable JEV test model"[^>]*>/)?.[0]
  assert.ok(input)
  assert.match(input, /checked/)
  assert.match(input, /disabled/)
  assert.match(markup, /Enable this provider to use its models/)
})

test('only pending target controls are disabled and failures keep confirmed check state visible', () => {
  const target = availabilityTarget(snapshot.models[0])
  const markup = render(
    createElement(ProviderModelList, {
      models: snapshot.models,
      state: { ...state, pending: [target], errors: { [target]: 'disk unavailable' } },
      providerEnabled: true,
      onChange: () => undefined
    })
  )
  assert.match(markup, /disk unavailable/)
  const input = markup.match(/<input[^>]*aria-label="Enable JEV test model"[^>]*>/)?.[0]
  assert.ok(input)
  assert.match(input, /checked/)
  assert.match(input, /disabled/)
})

test('capability labels and search recognize decision providers in both languages without changing IDs', () => {
  const label = providerCapabilityLabel
  const savedSwitchLabel = providerManagementUi.providerSwitch
  assert.equal(label(provider), 'Decision · JEV')
  assert.equal(filterProviders([provider], 'JEV')[0].providerId, 'typesafe')
  assert.equal(filterProviders([provider], '决策')[0].providerId, 'typesafe')
  assert.equal(filterProviderModels(snapshot.models, 'decision')[0].modelId, 'jev-test')
  setUiLanguage('zh-CN')
  assert.equal(label(provider), '决策 · JEV')
  assert.equal(savedSwitchLabel('TypeSafe'), '启用 TypeSafe 提供商')
  assert.equal(filterProviderModels(snapshot.models, '决策')[0].modelId, 'jev-test')
  const markup = render(createElement(ProviderCard, base))
  assert.doesNotMatch(markup, /Phi 自动使用已启用的决策模型/)
  assert.match(markup, /启用 TypeSafe 提供商/)
  assert.doesNotMatch(markup, /用于决策的模型|使用当前对话模型<\/button>/)
})
