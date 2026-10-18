import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'

import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { wrapperCopy } from '../src/renderer/src/features/wrapper/lib/wrapperCopy'
import {
  localizeRemoteSetupMessage,
  remoteSetupCopy
} from '../src/renderer/src/features/wrapper/lib/remoteSetupCopy'
import { remoteSetupEnglish } from '../src/renderer/src/features/wrapper/lib/remoteSetupCopy.en'
import { remoteSetupChinese } from '../src/renderer/src/features/wrapper/lib/remoteSetupCopy.zh'
import {
  filterWrapperCatalogChoices,
  wrapperCatalogGroups,
  type WrapperCatalogChoice
} from '../src/renderer/src/features/wrapper/lib/wrapperCatalog'
import { filterWrappers } from '../src/renderer/src/features/wrapper/lib/wrapperSidebar'
import { buildWrapperParamsFlowGraph } from '../src/renderer/src/features/wrapper/lib/wrapperFlow'
import { WrapperContractSections } from '../src/renderer/src/features/wrapper/components/WrapperContract'
import { RemoteRuntimeRootControl } from '../src/renderer/src/features/wrapper/components/RemoteRuntimeRootControl'
import { RemoteHostPasswordBootstrapDialogView } from '../src/renderer/src/features/wrapper/components/RemoteHostPasswordBootstrapDialog'
import {
  sshBootstrapErrorMessage,
  type SshBootstrapUiActions
} from '../src/renderer/src/features/wrapper/lib/sshBootstrapUi'
import { summarizeWrapperInstallPlan } from '../src/renderer/src/features/wrapper/lib/wrapperInstallPlan'
import type { PackageInstallPlanView } from '../src/shared/packageManagerTypes'
import type { SshBootstrapPublicErrorCode } from '../src/shared/sshBootstrapTypes'
import { EnvironmentBuildConfirmDialog } from '../src/renderer/src/components/EnvironmentBuildConfirmDialog'

afterEach(() => setUiLanguage('en'))

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      {
        theme: createTheme({ components: { MuiDialog: { defaultProps: { disablePortal: true } } } })
      },
      element
    )
  )
}

test('Wrapper dictionaries and saved formatter references resolve the selected language', () => {
  const installTitle = wrapperCopy.installTitle
  const runStates = wrapperCopy.runStates
  assert.equal(installTitle('fastqc'), 'Install fastqc')
  assert.equal(runStates.running, 'Running')
  assert.deepEqual(Object.keys(remoteSetupEnglish).sort(), Object.keys(remoteSetupChinese).sort())

  setUiLanguage('zh-CN')
  assert.equal(installTitle('fastqc'), '安装 fastqc')
  assert.equal(runStates.running, '运行中')
  assert.equal(remoteSetupCopy.confirmHostKey, '确认服务器主机密钥')
  assert.equal(remoteSetupCopy.nextflowPath, 'Nextflow 路径')
})

test('category labels and search switch while canonical Wrapper and category IDs stay stable', () => {
  const choices: WrapperCatalogChoice[] = [
    {
      id: 'module-nf-core-fastqc',
      title: '作者原名',
      summary: 'Author description',
      metadata: 'nf-core',
      category: '模块',
      installed: false,
      selected: false,
      enabled: false
    }
  ]
  assert.deepEqual(wrapperCatalogGroups(choices), [
    { id: 'all', label: 'All Wrappers', count: 1 },
    { id: 'category:模块', label: 'Modules', count: 1 }
  ])
  assert.equal(filterWrapperCatalogChoices(choices, 'Modules')[0]?.id, choices[0].id)
  assert.equal(filterWrapperCatalogChoices(choices, '模块')[0], choices[0])
  setUiLanguage('zh-CN')
  assert.deepEqual(wrapperCatalogGroups(choices), [
    { id: 'all', label: '全部 Wrapper', count: 1 },
    { id: 'category:模块', label: '模块', count: 1 }
  ])
  assert.equal(filterWrapperCatalogChoices(choices, '模块', 'category:模块')[0], choices[0])
  assert.equal(filterWrapperCatalogChoices(choices, 'Modules', 'category:模块')[0], choices[0])
  const sidebar = [
    {
      id: 'nf-core/modules/fastqc',
      name: 'fastqc',
      summary: 'Author summary',
      params: {},
      outputs: {}
    }
  ]
  assert.equal(filterWrappers(sidebar, 'Modules')[0], sidebar[0])
  assert.equal(filterWrappers(sidebar, '模块')[0], sidebar[0])
  assert.equal(choices[0].title, '作者原名')
  assert.equal(choices[0].summary, 'Author description')
})

test('Wrapper contract sections and graph fallbacks localize without changing author metadata', () => {
  const manifest = {
    id: 'nf-core/modules/fastqc',
    name: 'Author name',
    summary: '作者说明',
    params: {},
    outputs: {}
  }
  assert.match(render(createElement(WrapperContractSections, { manifest })), />Inputs</)
  const source = { name: 'Author name', inputLabels: [], outputLabels: [] }
  assert.equal(buildWrapperParamsFlowGraph(source).nodes[0].data.label, 'Inputs')
  setUiLanguage('zh-CN')
  const markup = render(createElement(WrapperContractSections, { manifest }))
  assert.match(markup, />输入</)
  assert.match(markup, />输出</)
  assert.match(markup, />无</)
  assert.equal(buildWrapperParamsFlowGraph(source).nodes[0].data.label, '输入')
  assert.equal(buildWrapperParamsFlowGraph(source).nodes[1].data.label, 'Author name')
})

test('runtime source and controls do not capture the language used when the module loaded', () => {
  const props = {
    label: '/author/label',
    value: '',
    effective: { source: 'default' as const, configured: '~/.phi/runtime' },
    doctorState: { phase: 'idle' as const },
    doctorTargetKey: 'same-target',
    busy: false,
    onChange: () => undefined,
    onCheck: () => undefined
  }
  assert.match(render(createElement(RemoteRuntimeRootControl, props)), /from Default/)
  setUiLanguage('zh-CN')
  const markup = render(createElement(RemoteRuntimeRootControl, props))
  assert.match(markup, /实际值：/)
  assert.match(markup, /来自默认/)
  assert.match(markup, /~\/.phi\/runtime/)
  assert.match(markup, />检查</)
})

test('changing language during SSH password verification preserves the progress phase and model', () => {
  const noop = (): void => undefined
  const actions: SshBootstrapUiActions = {
    startInspection: noop,
    confirmHostKey: noop,
    setPassword: noop,
    verifyPassword: noop,
    configurePasswordless: noop,
    skipPasswordless: noop,
    setPassphrase: noop,
    setPassphraseConfirmation: noop,
    setPasswordlessAcknowledged: noop,
    submitCredentials: noop,
    saveConfig: noop,
    declineConfig: noop,
    close: noop
  }
  const model = {
    phase: 'progress' as const,
    target: { alias: 'author-alias', hostname: 'host.example', user: 'researcher', port: 22 },
    busy: true as const,
    error: null,
    completedSteps: [remoteSetupCopy.hostKeyConfirmed],
    currentStep: remoteSetupCopy.testingPasswordStep
  }
  setUiLanguage('zh-CN')
  const markup = render(
    createElement(RemoteHostPasswordBootstrapDialogView, { open: true, model, actions })
  )
  assert.match(markup, /正在测试密码连接/)
  assert.match(markup, /服务器主机密钥已确认/)
  assert.doesNotMatch(markup, /正在配置密钥登录/)
  assert.equal(model.currentStep, 'Testing the password connection…')
  assert.match(markup, /author-alias/)
  assert.equal(
    localizeRemoteSetupMessage('arbitrary server diagnostics'),
    'arbitrary server diagnostics'
  )
})

test('environment build confirmation follows the global language', () => {
  const props = {
    environment: { ref: 'author-env' },
    working: false,
    onClose: () => undefined,
    onConfirm: () => undefined
  }
  assert.match(render(createElement(EnvironmentBuildConfirmDialog, props)), /Build author-env\?/)
  setUiLanguage('zh-CN')
  assert.match(render(createElement(EnvironmentBuildConfirmDialog, props)), /构建 author-env？/)
})

test('saved install summaries resolve package kinds through en → zh → en switches', () => {
  const rootId = 'workflow-nf-core-rnaseq'
  const plan: PackageInstallPlanView = {
    registry: {
      id: 'registry',
      dir: '/registry',
      trust: 'builtin',
      schemaVersion: 1,
      generatedAt: '',
      packages: []
    },
    root: { type: 'wrapper', id: rootId, version: '1.0.0' },
    packages: ['module-nf-core-fastqc', 'subworkflow-nf-core-qc', 'custom-id'].map((id) => ({
      id,
      type: 'wrapper',
      version: '1.0.0',
      title: id,
      summary: 'Author description',
      archive: `${id}.tar.gz`,
      sha256: 'a'.repeat(64),
      size: 1,
      dependsOn: [],
      installedBy: 'dependency'
    })),
    totalSize: 3,
    environments: [],
    agentDir: '/agent'
  }
  const summarize = summarizeWrapperInstallPlan
  const summary = summarize(plan, rootId)
  const kinds = (): Record<string, string> =>
    Object.fromEntries([summary.root, ...summary.dependencies].map(({ id, kind }) => [id, kind]))
  const english = kinds()
  assert.deepEqual(english, {
    [rootId]: 'Workflow',
    'module-nf-core-fastqc': 'Module',
    'subworkflow-nf-core-qc': 'Subworkflow',
    'custom-id': 'Other'
  })
  setUiLanguage('zh-CN')
  assert.deepEqual(kinds(), {
    [rootId]: '工作流',
    'module-nf-core-fastqc': '模块',
    'subworkflow-nf-core-qc': '子流程',
    'custom-id': '其他'
  })
  assert.deepEqual(
    summarize(plan, rootId).dependencies.map(({ id }) => id),
    summary.dependencies.map(({ id }) => id)
  )
  setUiLanguage('en')
  assert.deepEqual(kinds(), english)
  assert.equal(summary.totalSize, 3)
  assert.equal(summary.root.version, '1.0.0')
  assert.deepEqual(
    plan.packages.map(({ archive }) => archive),
    ['module-nf-core-fastqc.tar.gz', 'subworkflow-nf-core-qc.tar.gz', 'custom-id.tar.gz']
  )
})

test('saved public SSH error formatter follows en → zh → en without changing error codes', () => {
  const codes: SshBootstrapPublicErrorCode[] = [
    'proxy_unsupported',
    'keyboard_interactive_unsupported',
    'pubkey_auth_disabled',
    'openssh_too_old',
    'host_key_changed',
    'authentication_failed',
    'password_attempts_exhausted',
    'linux_agent_missing',
    'key_not_loaded',
    'unsupported_platform',
    'unexpected'
  ]
  const message = sshBootstrapErrorMessage
  const english = codes.map(message)
  assert.equal(message('unexpected'), remoteSetupEnglish.bootstrapUnexpected)
  setUiLanguage('zh-CN')
  assert.equal(message('unexpected'), remoteSetupChinese.bootstrapUnexpected)
  assert.equal(message('authentication_failed'), remoteSetupChinese.bootstrapAuthenticationFailed)
  assert.ok(codes.every((code, index) => message(code) !== english[index]))
  assert.match(message('host_key_changed'), /known_hosts/)
  assert.match(message('linux_agent_missing'), /ssh-agent/)
  setUiLanguage('en')
  assert.deepEqual(codes.map(message), english)
  assert.match(message('unexpected'), /Command output is hidden to protect credentials/)
})
