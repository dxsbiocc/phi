import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPhiRemoteProjectSystemPrompt,
  type RemoteRuntimePromptContext
} from '../src/main/agent/main-system-prompt'
import {
  remoteRuntimeRootLabel,
  resolveRemoteRuntimePromptContext
} from '../src/main/agent/remote-runtime-context'

function prompt(runtime: RemoteRuntimePromptContext): string {
  return buildPhiRemoteProjectSystemPrompt(
    ['Current directory: /local/private/anchor'],
    '/local/private/anchor',
    '/cluster/project',
    { runtime }
  ).join('\n')
}

test('remote prompt reports a safe runtime root label and installed micromamba', () => {
  const rendered = prompt({
    rootLabel: '~/.phi/runtime',
    source: 'default',
    micromambaStatus: 'installed',
    ripgrepStatus: 'system',
    micromambaPathLabel: '~/.phi/runtime/bin/micromamba-2.9.0-0/micromamba'
  })
  assert.match(rendered, /~\/.phi\/runtime/)
  assert.match(rendered, /micromamba is installed and runnable/i)
  assert.match(rendered, /ripgrep is available from the server PATH/i)
  assert.match(rendered, /~\/\.phi\/runtime\/bin\/micromamba-2\.9\.0-0\/micromamba/)
  assert.match(rendered, /content-addressed skill resources/i)
  assert.match(rendered, /SSH login host/i)
  assert.match(rendered, /notebook\.list.*notebook\.save/i)
  assert.match(rendered, /Jupyter.*login host/i)
  assert.match(rendered, /explicitly starts the remote Notebook runtime/i)
  assert.match(rendered, /Never substitute a local environment/i)
  assert.doesNotMatch(rendered, /local\/private\/anchor/)
})

test('remote prompt redacts absolute runtime paths and gives setup guidance without installing', () => {
  const rendered = prompt({
    rootLabel: '$PHI_REMOTE_RUNTIME_ROOT',
    source: 'host',
    micromambaStatus: 'not-installed',
    ripgrepStatus: 'not-installed',
    micromambaPathLabel: '$PHI_REMOTE_RUNTIME_ROOT/bin/micromamba-2.9.0-0/micromamba'
  })
  assert.match(rendered, /\$PHI_REMOTE_RUNTIME_ROOT/)
  assert.match(rendered, /remote host settings/i)
  assert.match(rendered, /will not install it automatically/i)
  assert.match(rendered, /install ripgrep in remote host settings/i)
  assert.match(rendered, /\$PHI_REMOTE_RUNTIME_ROOT\/bin\/micromamba-2\.9\.0-0\/micromamba/)
  assert.doesNotMatch(rendered, /alice|cluster-a|\/home\//i)
})

test('remote prompt distinguishes outdated, unusable and unchecked micromamba', () => {
  for (const [status, expected] of [
    ['outdated', /outdated/i],
    ['unusable', /not usable by micromamba run/i],
    ['unchecked', /has not been verified/i]
  ] as const) {
    assert.match(
      prompt({
        rootLabel: '$PHI_REMOTE_RUNTIME_ROOT',
        source: 'project',
        micromambaStatus: status,
        ripgrepStatus: 'managed'
      }),
      expected
    )
  }
  assert.match(
    prompt({
      rootLabel: '$PHI_REMOTE_RUNTIME_ROOT',
      source: 'project',
      micromambaStatus: 'unusable',
      ripgrepStatus: 'managed'
    }),
    /micromamba run.*legacy file layouts.*reinstall/i
  )
})

test('runtime context reads only host metadata and redacts absolute configured roots', () => {
  const context = resolveRemoteRuntimePromptContext(
    { hostProfileId: 'profile-1', canonicalRoot: '/cluster/project' },
    '/local/agent',
    {
      getHostProfile: () => ({ id: 'profile-1', label: 'Secret', hostAlias: 'cluster-secret' }),
      readHostRoot: () => '/home/alice/private/runtime',
      readMicromambaStatus: (hostAlias, projectRoot, agentDir) => {
        assert.equal(hostAlias, 'cluster-secret')
        assert.equal(projectRoot, '/cluster/project')
        assert.equal(agentDir, '/local/agent')
        return 'installed'
      },
      readRipgrepStatus: () => 'managed',
      readMicromambaVersion: () => '2.9.0-0'
    }
  )
  assert.deepEqual(context, {
    rootLabel: '$PHI_REMOTE_RUNTIME_ROOT',
    source: 'host',
    micromambaStatus: 'installed',
    ripgrepStatus: 'managed',
    micromambaPathLabel: '$PHI_REMOTE_RUNTIME_ROOT/bin/micromamba-2.9.0-0/micromamba'
  })
  assert.equal(remoteRuntimeRootLabel('~/.phi/custom'), '~/.phi/custom')
})

test('runtime prompt context uses the same project runtime-root override as execution', () => {
  const context = resolveRemoteRuntimePromptContext(
    {
      hostProfileId: 'profile-1',
      canonicalRoot: '/cluster/project',
      projectOverride: '/project/runtime'
    },
    '/local/agent',
    {
      getHostProfile: () => ({ id: 'profile-1', label: 'Secret', hostAlias: 'cluster-secret' }),
      readHostRoot: () => '/host/runtime',
      readMicromambaStatus: () => 'installed',
      readRipgrepStatus: () => 'not-installed',
      readMicromambaVersion: () => '2.9.0-0'
    }
  )
  assert.deepEqual(context, {
    rootLabel: '$PHI_REMOTE_RUNTIME_ROOT',
    source: 'project',
    micromambaStatus: 'installed',
    ripgrepStatus: 'not-installed',
    micromambaPathLabel: '$PHI_REMOTE_RUNTIME_ROOT/bin/micromamba-2.9.0-0/micromamba'
  })
})
