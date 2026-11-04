import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { TeamSourceList } from '../src/renderer/src/features/team/components/TeamSourceList'
import { MemberIdentityCard } from '../src/renderer/src/features/team/components/MemberIdentityCard'
import { PassphraseDialogView } from '../src/renderer/src/features/team/components/PassphraseDialog'
import { passphraseStrength } from '../src/renderer/src/features/team/lib/teamSecurity'
import type { TeamSourceView } from '../src/renderer/src/features/team/lib/teamTypes'
import { AddTeamSourceDialogView } from '../src/renderer/src/features/team/components/AddTeamSourceDialog'
import { RemoveTeamSourceDialog } from '../src/renderer/src/features/team/components/RemoveTeamSourceDialog'
import {
  AdminTeamList,
  CreatedTeamBackupDialog
} from '../src/renderer/src/features/team/components/AdminTeamList'
import { AdminMembersSection } from '../src/renderer/src/features/team/components/AdminMembersSection'
import {
  AddAdminMemberDialogView,
  RemoveAdminMemberDialog
} from '../src/renderer/src/features/team/components/AdminMemberDialogs'
import { MemberModelsDialogView } from '../src/renderer/src/features/team/components/MemberModelsDialog'
import { TeamPublishSection } from '../src/renderer/src/features/team/components/TeamPublishSection'
import {
  ReleaseHistorySection,
  WithdrawReleaseDialog
} from '../src/renderer/src/features/team/components/ReleaseHistorySection'
import { TeamSettingsPanel } from '../src/renderer/src/features/team/TeamSettingsPanel'
import { MemberSubmissionDialog } from '../src/renderer/src/features/team/components/MemberSubmissionDialog'
import { AdminSubmissionsSection } from '../src/renderer/src/features/team/components/AdminSubmissionsSection'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

beforeEach(() => setUiLanguage('en'))
afterEach(() => setUiLanguage('en'))

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      {
        theme: createTheme({
          components: { MuiDialog: { defaultProps: { disablePortal: true } } }
        })
      },
      node
    )
  )
}

test('member source list renders the healthy state in both interface languages', () => {
  const source = {
    id: 'source-1',
    teamId: 'team-1',
    teamName: 'Atlas Lab',
    publicKeyFingerprint: 'a1b2c3d4e5f60708',
    location: { kind: 'directory' as const, path: '/Shared/atlas' },
    addedAt: '2026-11-01T09:00:00.000Z',
    status: {
      state: 'healthy' as const,
      lastSuccessfulRelease: 4,
      lastCheckedAt: '2026-11-04T09:30:00.000Z',
      lastErrorCode: null,
      withdrawnReleases: [],
      credentialProviders: ['openai'],
      configuredProviders: ['openai'],
      credentialConflicts: [],
      skippedProviders: [],
      announcements: [],
      resources: {}
    }
  }

  const english = render(
    createElement(TeamSourceList, {
      sources: [source],
      busySourceId: null,
      onCheck: () => undefined,
      onRemove: () => undefined
    })
  )
  assert.match(english, /Atlas Lab/)
  assert.match(english, /Healthy/)
  assert.match(english, /Version 4/)
  assert.match(english, /Check now/)

  setUiLanguage('zh-CN')
  const chinese = render(
    createElement(TeamSourceList, {
      sources: [source],
      busySourceId: null,
      onCheck: () => undefined,
      onRemove: () => undefined
    })
  )
  assert.match(chinese, /Atlas Lab/)
  assert.match(chinese, /正常/)
  assert.match(chinese, /版本 4/)
  assert.match(chinese, /立即检查/)
})

test('member source list explains degraded states and model credential decisions without keys', () => {
  setUiLanguage('zh-CN')
  const makeSource = (
    id: string,
    state: 'cached' | 'not-member' | 'withdrawn' | 'error',
    extras: Partial<{
      credentialProviders: string[]
      credentialConflicts: string[]
      skippedProviders: string[]
    }> = {}
  ): TeamSourceView => ({
    id,
    teamId: `team-${id}`,
    teamName: `Team ${id}`,
    publicKeyFingerprint: 'a1b2c3d4e5f60708',
    location: { kind: 'https' as const, url: `https://example.test/${id}` },
    addedAt: '2026-11-01T09:00:00.000Z',
    status: {
      state,
      lastSuccessfulRelease: 3,
      lastCheckedAt: '2026-11-04T09:30:00.000Z',
      lastErrorCode: state === 'error' ? 'STORE_UNAVAILABLE' : null,
      withdrawnReleases: state === 'withdrawn' ? [3] : [],
      credentialProviders: extras.credentialProviders ?? [],
      configuredProviders: extras.credentialProviders ?? [],
      credentialConflicts: extras.credentialConflicts ?? [],
      skippedProviders: extras.skippedProviders ?? [],
      announcements: [],
      resources: {}
    }
  })
  const markup = render(
    createElement(TeamSourceList, {
      sources: [
        makeSource('cached', 'cached'),
        makeSource('former', 'not-member'),
        makeSource('withdrawn', 'withdrawn'),
        makeSource('error', 'error', {
          credentialProviders: ['openai'],
          credentialConflicts: ['anthropic'],
          skippedProviders: ['unsupported-provider']
        })
      ],
      busySourceId: null,
      onCheck: () => undefined,
      onRemove: () => undefined
    })
  )

  assert.match(markup, /使用缓存/)
  assert.match(markup, /已不是成员/)
  assert.match(markup, /之后的版本拿不到，已经安装的资源仍在本机/)
  assert.match(markup, /版本已撤回/)
  assert.match(markup, /出错/)
  assert.match(markup, /openai/)
  assert.match(markup, /你自己已配置了 anthropic，保留你的/)
  assert.match(markup, /已跳过 unsupported-provider/)
  assert.doesNotMatch(markup, /sk-[A-Za-z0-9]/)
})

test('member identity labels the recipient as public and explains safe sharing', () => {
  setUiLanguage('zh-CN')
  const recipient = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
  const markup = render(
    createElement(MemberIdentityCard, {
      recipient,
      errorCode: null,
      onCopy: () => undefined,
      onExport: () => undefined,
      onImport: () => undefined
    })
  )

  assert.match(markup, /我的成员公钥/)
  assert.match(markup, new RegExp(recipient))
  assert.match(markup, /发给团队管理员；不包含任何秘密/)
  assert.match(markup, /导出身份备份/)
  assert.match(markup, /导入身份备份/)
})

test('member submission dialog localizes selectable, restricted, and delivered states', () => {
  const props = {
    open: true,
    teamName: 'Atlas Lab',
    candidates: [
      {
        type: 'skill' as const,
        id: 'open-skill',
        version: '1.0.0',
        title: 'Open skill',
        summary: 'Open',
        canSubmit: true
      },
      {
        type: 'plugin' as const,
        id: 'team-only-plugin',
        version: '2.0.0',
        title: 'Restricted plugin',
        summary: 'Restricted',
        canSubmit: false,
        reason: 'team-only' as const
      }
    ],
    selected: ['skill:open-skill'],
    note: 'Review this',
    busy: false,
    errorCode: null,
    result: null,
    onToggle: () => undefined,
    onNoteChange: () => undefined,
    onClose: () => undefined,
    onSubmit: () => undefined
  }
  const english = render(createElement(MemberSubmissionDialog, props))
  assert.match(english, /Submit resources to Atlas Lab/)
  assert.match(english, /restricted to its source team/)
  assert.match(english, /Note to the administrator/)

  setUiLanguage('zh-CN')
  const chinese = render(
    createElement(MemberSubmissionDialog, {
      ...props,
      result: {
        submissionId: 'submission-1',
        delivery: 'export' as const,
        path: '/tmp/submission.phi-submission'
      }
    })
  )
  assert.match(chinese, /向 Atlas Lab 投稿/)
  assert.match(chinese, /仅限其来源团队使用/)
  assert.match(chinese, /投稿文件已导出/)
})

test('administrator submission review warns about code and explains invalid entries bilingually', () => {
  const props = {
    submissions: [
      {
        entryId: 'entry-1',
        valid: true,
        memberName: 'Lin',
        packages: [
          {
            type: 'skill' as const,
            id: 'shared-analysis',
            version: '2.0.0',
            sha256: 'a'.repeat(64)
          }
        ],
        note: 'Review the parser.',
        createdAt: '2026-11-04T01:00:00.000Z',
        bytes: 1024
      },
      {
        entryId: 'entry-2',
        valid: false,
        invalidReasonCode: 'signature' as const,
        packages: [],
        bytes: 100
      }
    ],
    busy: false,
    onRefresh: () => undefined,
    onImport: () => undefined,
    onAccept: () => undefined,
    onDelete: () => undefined
  }
  const english = render(createElement(AdminSubmissionsSection, props))
  assert.match(english, /member-provided code/)
  assert.match(english, /From Lin/)
  assert.match(english, /member signature is invalid/i)

  setUiLanguage('zh-CN')
  const chinese = render(createElement(AdminSubmissionsSection, props))
  assert.match(chinese, /投稿内容是成员提供的代码/)
  assert.match(chinese, /来自 Lin/)
  assert.match(chinese, /成员签名无效/)
})

test('backup passphrase view keeps inputs enabled and gates submission on strength and equality', () => {
  assert.equal(passphraseStrength('short').level, 'weak')
  assert.equal(passphraseStrength('correct horse battery staple').level, 'strong')

  setUiLanguage('en')
  const weak = render(
    createElement(PassphraseDialogView, {
      open: true,
      kind: 'member-export',
      passphrase: 'short',
      confirmation: 'different',
      busy: true,
      errorCode: null,
      onPassphraseChange: () => undefined,
      onConfirmationChange: () => undefined,
      onClose: () => undefined,
      onSubmit: () => undefined
    })
  )
  assert.match(weak, /Weak passphrase/)
  assert.match(weak, /Passphrases do not match/)
  assert.doesNotMatch(weak, /<input[^>]*disabled/)
  assert.match(weak, /<button[^>]*disabled[^>]*>[^<]*Export/)

  setUiLanguage('zh-CN')
  const strong = render(
    createElement(PassphraseDialogView, {
      open: true,
      kind: 'member-import',
      passphrase: 'correct horse battery staple',
      confirmation: 'correct horse battery staple',
      busy: false,
      errorCode: null,
      onPassphraseChange: () => undefined,
      onConfirmationChange: () => undefined,
      onClose: () => undefined,
      onSubmit: () => undefined
    })
  )
  assert.match(strong, /强口令/)
  assert.match(strong, /会替换当前身份/)
  assert.match(strong, /导入/)

  const chineseError = render(
    createElement(PassphraseDialogView, {
      open: true,
      kind: 'member-import',
      passphrase: 'correct horse battery staple',
      confirmation: 'correct horse battery staple',
      busy: false,
      errorCode: 'BAD_PASSPHRASE',
      onPassphraseChange: () => undefined,
      onConfirmationChange: () => undefined,
      onClose: () => undefined,
      onSubmit: () => undefined
    })
  )
  assert.match(chineseError, /备份口令不正确/)

  setUiLanguage('en')
  const englishError = render(
    createElement(PassphraseDialogView, {
      open: true,
      kind: 'member-import',
      passphrase: 'correct horse battery staple',
      confirmation: 'correct horse battery staple',
      busy: false,
      errorCode: 'BAD_PASSPHRASE',
      onPassphraseChange: () => undefined,
      onConfirmationChange: () => undefined,
      onClose: () => undefined,
      onSubmit: () => undefined
    })
  )
  assert.match(englishError, /backup passphrase is incorrect/i)
})

test('add-team dialog confirms the verified team name before saving and localizes trust errors', () => {
  setUiLanguage('zh-CN')
  const markup = render(
    createElement(AddTeamSourceDialogView, {
      open: true,
      locationKind: 'https',
      locationValue: 'https://packages.example/atlas',
      fingerprint: 'aa:bb:cc:dd',
      preview: {
        teamId: 'atlas',
        teamName: 'Atlas Lab',
        publicKeyFingerprint: 'aa:bb:cc:dd',
        location: { kind: 'https', url: 'https://packages.example/atlas' }
      },
      busy: 'preview',
      errorCode: 'UNTRUSTED_TEAM_KEY',
      onLocationKindChange: () => undefined,
      onLocationValueChange: () => undefined,
      onFingerprintChange: () => undefined,
      onPickDirectory: () => undefined,
      onPreview: () => undefined,
      onSave: () => undefined,
      onClose: () => undefined
    })
  )

  assert.match(markup, /添加团队/)
  assert.match(markup, /HTTPS 地址/)
  assert.match(markup, /团队公钥指纹/)
  assert.match(markup, /Atlas Lab/)
  assert.match(markup, /确认这是你要加入的团队/)
  assert.match(markup, /指纹不匹配/)
  assert.doesNotMatch(markup, /<input[^>]*disabled/)
  assert.match(markup, /<button[^>]*disabled[^>]*>[^<]*保存/)
})

test('remove-team confirmation explains credential cleanup and retained installed resources', () => {
  setUiLanguage('en')
  const markup = render(
    createElement(RemoveTeamSourceDialog, {
      source: {
        id: 'source-1',
        teamId: 'team-1',
        teamName: 'Atlas Lab',
        teamKeyId: 'a1b2c3d4e5f60708',
        location: { kind: 'directory', path: '/Shared/atlas' },
        addedAt: '2026-11-01T09:00:00.000Z',
        status: {
          state: 'healthy',
          lastSuccessfulRelease: 4,
          lastCheckedAt: null,
          lastErrorCode: null,
          withdrawnReleases: [],
          credentialProviders: ['openai'],
          credentialConflicts: [],
          skippedProviders: []
        }
      },
      busy: false,
      onClose: () => undefined,
      onConfirm: () => undefined
    })
  )
  assert.match(markup, /Remove Atlas Lab/)
  assert.match(markup, /Model keys written by this team will be removed/)
  assert.match(markup, /Installed resources are not uninstalled automatically/)
})

test('administrator team list exposes creation, recovery, fingerprint, and mandatory backup prompt', () => {
  setUiLanguage('zh-CN')
  const listMarkup = render(
    createElement(AdminTeamList, {
      teams: [
        {
          teamId: 'team-atlas',
          name: 'Atlas Lab',
          publicKeyFingerprint: 'aa:bb:cc:dd'
        }
      ],
      selectedTeamId: null,
      onSelect: () => undefined,
      onCreate: () => undefined,
      onRestore: () => undefined,
      onCopyFingerprint: () => undefined
    })
  )
  assert.match(listMarkup, /我管理的团队/)
  assert.match(listMarkup, /创建团队/)
  assert.match(listMarkup, /从备份恢复团队/)
  assert.match(listMarkup, /Atlas Lab/)
  assert.match(listMarkup, /aa:bb:cc:dd/)

  const backupMarkup = render(
    createElement(CreatedTeamBackupDialog, {
      team: {
        teamId: 'team-atlas',
        name: 'Atlas Lab',
        publicKeyFingerprint: 'aa:bb:cc:dd',
        backupRequired: true,
        warning: 'raw backend warning'
      },
      onCopy: () => undefined,
      onExport: () => undefined,
      onClose: () => undefined
    })
  )
  assert.match(backupMarkup, /团队创建成功/)
  assert.match(backupMarkup, /签名密钥丢失后无法恢复团队/)
  assert.match(backupMarkup, /立即备份签名密钥/)
  assert.doesNotMatch(backupMarkup, /raw backend warning/)
})

test('administrator members list and dialogs show public identity, grants, and honest removal limits', () => {
  setUiLanguage('zh-CN')
  const member = {
    memberId: 'member-1',
    displayName: 'Lin',
    recipient: 'age1abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop',
    addedAt: '2026-11-01T09:00:00.000Z'
  }
  const listMarkup = render(
    createElement(AdminMembersSection, {
      members: [member],
      modelGrants: [
        {
          memberId: 'member-1',
          models: [
            { providerId: 'openai', label: 'Lab quota' },
            { providerId: 'anthropic', label: 'Claude seat' }
          ]
        }
      ],
      onAdd: () => undefined,
      onEditModels: () => undefined,
      onRemove: () => undefined
    })
  )
  assert.match(listMarkup, /成员/)
  assert.match(listMarkup, /添加成员/)
  assert.match(listMarkup, /Lin/)
  assert.match(listMarkup, /age1abcdef/)
  assert.match(listMarkup, /openai · Lab quota/)
  assert.match(listMarkup, /anthropic · Claude seat/)
  assert.doesNotMatch(listMarkup, /sk-secret/)

  const addMarkup = render(
    createElement(AddAdminMemberDialogView, {
      open: true,
      displayName: '',
      recipient: '',
      busy: true,
      errorCode: null,
      onDisplayNameChange: () => undefined,
      onRecipientChange: () => undefined,
      onClose: () => undefined,
      onSubmit: () => undefined
    })
  )
  assert.match(addMarkup, /显示名/)
  assert.match(addMarkup, /成员公钥/)
  assert.doesNotMatch(addMarkup, /<input[^>]*disabled/)

  const removeMarkup = render(
    createElement(RemoveAdminMemberDialog, {
      member,
      busy: false,
      onClose: () => undefined,
      onConfirm: () => undefined
    })
  )
  assert.match(removeMarkup, /之后的版本他拿不到/)
  assert.match(removeMarkup, /已经拿到的资源和模型 key 收不回来/)
  assert.match(removeMarkup, /服务商后台吊销/)
})

test('model sub-key editor accepts provider metadata and one-way password inputs without subscription sharing', () => {
  setUiLanguage('en')
  const markup = render(
    createElement(MemberModelsDialogView, {
      open: true,
      memberName: 'Lin',
      models: [
        {
          providerId: 'openai',
          label: 'Lab quota',
          apiKey: 'sk-secret-test-value',
          baseUrl: 'https://api.example/v1'
        }
      ],
      busy: true,
      errorCode: null,
      onAdd: () => undefined,
      onRemove: () => undefined,
      onChange: () => undefined,
      onClose: () => undefined,
      onSubmit: () => undefined
    })
  )

  assert.match(markup, /Model sub-keys for Lin/)
  assert.match(markup, /Only API keys can be shared/)
  assert.match(markup, /Personal subscription accounts cannot be shared/)
  assert.match(markup, /Provider/)
  assert.match(markup, /Label/)
  assert.match(markup, /API key/)
  assert.match(markup, /Base URL \(optional\)/)
  assert.match(markup, /type="password"/)
  assert.doesNotMatch(markup, /<input[^>]*disabled/)
  assert.match(markup, /<button[^>]*disabled[^>]*>[^<]*Save/)
})

test('model sub-key editor rejects duplicate providers before secrets reach main', () => {
  setUiLanguage('zh-CN')
  const markup = render(
    createElement(MemberModelsDialogView, {
      open: true,
      memberName: 'Lin',
      models: [
        { providerId: 'openai', label: 'Primary', apiKey: 'first-secret' },
        { providerId: 'openai', label: 'Secondary', apiKey: 'second-secret' }
      ],
      busy: false,
      errorCode: null,
      onAdd: () => undefined,
      onRemove: () => undefined,
      onChange: () => undefined,
      onClose: () => undefined,
      onSubmit: () => undefined
    })
  )

  assert.match(markup, /同一成员只能配置一次同一个 provider/)
  assert.match(markup, /<button[^>]*disabled[^>]*>[^<]*保存/)
})

test('publishing selects installed resources, explains the fixed folder, and reports the version to sync', () => {
  setUiLanguage('zh-CN')
  const markup = render(
    createElement(TeamPublishSection, {
      storeDir: '/Shared/atlas-team',
      teamId: 'atlas-team',
      latestRelease: 6,
      packages: [
        {
          id: 'rna-tools',
          type: 'skill',
          version: '1.2.0',
          title: 'RNA Tools',
          summary: 'RNA analysis',
          dir: '/managed/rna-tools',
          installedAt: '2026-11-01T09:00:00.000Z',
          installedBy: 'user',
          registry: 'official',
          sha256: 'a'.repeat(64),
          trust: 'official'
        }
      ],
      selected: ['skill:rna-tools'],
      sharingByKey: { 'skill:rna-tools': 'team-only' },
      announcement: '',
      busy: false,
      published: {
        release: 7,
        payloadBytes: 120,
        manifestSha256: 'b'.repeat(64),
        storeDir: '/Shared/atlas-team',
        packages: [{ type: 'skill', id: 'rna-tools', version: '1.2.0' }],
        withdrawnReleases: []
      },
      onToggle: () => undefined,
      onSharingChange: () => undefined,
      onAnnouncementChange: () => undefined,
      onPublish: () => undefined,
      onAnnounceOnly: () => undefined
    })
  )

  assert.match(markup, /发布/)
  assert.match(markup, /发布文件夹在第一次选择后固定/)
  assert.match(markup, /\/Shared\/atlas-team/)
  assert.match(markup, /RNA Tools/)
  assert.match(markup, /skill · 1.2.0/)
  assert.match(markup, /版本 7 发布成功/)
  assert.match(markup, /把这个文件夹同步给成员/)
})

test('release history shows recipients and withdrawal limits for downloaded and in-flight work', () => {
  setUiLanguage('en')
  const release = {
    release: 6,
    publishedAt: '2026-11-03T09:30:00.000Z',
    memberIds: ['member-1', 'member-2'],
    withdrawn: false,
    hasAnnouncement: false
  }
  const markup = render(
    createElement(ReleaseHistorySection, {
      releases: [release, { ...release, release: 5, withdrawn: true }],
      onWithdraw: () => undefined
    })
  )
  assert.match(markup, /Version history/)
  assert.match(markup, /Version 6/)
  assert.match(markup, /2 recipients/)
  assert.match(markup, /Withdrawn/)

  const confirmation = render(
    createElement(WithdrawReleaseDialog, {
      release,
      busy: false,
      onClose: () => undefined,
      onConfirm: () => undefined
    })
  )
  assert.match(confirmation, /Withdraw version 6/)
  assert.match(confirmation, /Downloaded content cannot be taken back/)
  assert.match(confirmation, /in-flight tasks are not affected/)
})

test('team settings panel owns member and administrator management without duplicating resources', () => {
  setUiLanguage('en')
  const english = render(createElement(TeamSettingsPanel))
  assert.match(english, /Team/)
  assert.match(english, /Teams I joined/)
  assert.match(english, /Teams I manage/)
  assert.match(english, /Shared resources continue to appear in the resource catalog/)

  setUiLanguage('zh-CN')
  const chinese = render(createElement(TeamSettingsPanel))
  assert.match(chinese, /团队/)
  assert.match(chinese, /我加入的团队/)
  assert.match(chinese, /我管理的团队/)
  assert.match(chinese, /共享资源仍显示在现有资源目录中/)
})
