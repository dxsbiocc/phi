import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildTerminalEnv,
  resolveTerminalShell,
  TERMINAL_MINIMAL_PATH,
  type TerminalFileExists
} from '../src/main/terminal/terminal-env'

describe('buildTerminalEnv', () => {
  it('keeps only the terminal allowlist and applies fixed terminal values', () => {
    const result = buildTerminalEnv({
      HOME: '/Users/phi',
      USER: 'phi',
      LOGNAME: 'phi',
      SHELL: '/bin/zsh',
      TMPDIR: '/tmp',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      LC_SECRET_LOOKING_BUT_ALLOWED_BY_CONTRACT: 'locale-value',
      HTTP_PROXY: 'http://upper-http',
      HTTPS_PROXY: 'http://upper-https',
      NO_PROXY: 'localhost',
      http_proxy: 'http://lower-http',
      https_proxy: 'http://lower-https',
      no_proxy: '127.0.0.1',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      TERM: 'source-term',
      COLORTERM: 'source-color',
      TERM_PROGRAM: 'source-program',
      PATH: '/secret/bin',
      PI_CODING_AGENT_DIR: '/secret/agent',
      ELECTRON_RENDERER_URL: 'http://internal',
      OPENAI_API_KEY: 'secret',
      MOONSHOT_BASE_URL: 'https://internal'
    })

    assert.deepEqual(result, {
      HOME: '/Users/phi',
      USER: 'phi',
      LOGNAME: 'phi',
      SHELL: '/bin/zsh',
      TMPDIR: '/tmp',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      LC_SECRET_LOOKING_BUT_ALLOWED_BY_CONTRACT: 'locale-value',
      HTTP_PROXY: 'http://upper-http',
      HTTPS_PROXY: 'http://upper-https',
      NO_PROXY: 'localhost',
      http_proxy: 'http://lower-http',
      https_proxy: 'http://lower-https',
      no_proxy: '127.0.0.1',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Phi',
      PATH: TERMINAL_MINIMAL_PATH
    })
  })

  it('defaults LANG only when the source does not define it', () => {
    assert.equal(buildTerminalEnv({}).LANG, 'en_US.UTF-8')
    assert.equal(buildTerminalEnv({ LANG: '' }).LANG, '')
  })
})

describe('resolveTerminalShell', () => {
  const shells = (): string => '# system shells\n/bin/zsh\n/bin/bash\n/opt/homebrew/bin/fish\n'

  function files(...paths: string[]): TerminalFileExists {
    const existing = new Set(paths)
    return (path) => existing.has(path)
  }

  it('uses an absolute, listed, executable SHELL', () => {
    assert.deepEqual(
      resolveTerminalShell(
        { SHELL: '/opt/homebrew/bin/fish' },
        files('/opt/homebrew/bin/fish', '/bin/zsh', '/bin/bash'),
        shells
      ),
      { application: '/opt/homebrew/bin/fish', args: ['-il'] }
    )
  })

  it('rejects an executable that is not listed in /etc/shells', () => {
    assert.deepEqual(
      resolveTerminalShell(
        { SHELL: '/opt/homebrew/bin/other-shell' },
        files('/opt/homebrew/bin/other-shell', '/bin/zsh'),
        shells
      ),
      {
        application: '/bin/zsh',
        args: ['-il'],
        fallbackReason: '/opt/homebrew/bin/other-shell is not listed in /etc/shells'
      }
    )
  })

  it('rejects relative and non-executable configured shells with a reason', () => {
    assert.equal(
      resolveTerminalShell({ SHELL: 'zsh' }, files('/bin/zsh'), shells).fallbackReason,
      'SHELL must be an absolute path'
    )
    assert.equal(
      resolveTerminalShell({ SHELL: '/opt/homebrew/bin/fish' }, files('/bin/zsh'), shells)
        .fallbackReason,
      '/opt/homebrew/bin/fish is not executable'
    )
  })

  it('falls back to bash when zsh is unavailable', () => {
    assert.deepEqual(resolveTerminalShell({}, files('/bin/bash'), shells), {
      application: '/bin/bash',
      args: ['-il'],
      fallbackReason: 'SHELL is not set'
    })
  })

  it('throws when neither supported fallback is executable', () => {
    assert.throws(
      () => resolveTerminalShell({}, files(), shells),
      /No supported terminal shell is executable/u
    )
  })
})
