import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { ChatBubble } from '../src/renderer/src/components/chat/ChatBubble'
import MarkdownContent from '../src/renderer/src/components/MarkdownContent'
import { ChatCodeActions } from '../src/renderer/src/features/chat/components/ChatCodeActions'
import { ChatShellConfirmation } from '../src/renderer/src/features/chat/components/ChatShellConfirmation'
import { chatItemsFromSessionMessages } from '../src/renderer/src/lib/chatItems'
import {
  createAgentEventReducerState,
  reduceAgentEventState
} from '../src/renderer/src/lib/agentEventReducer'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import type { ShellJobTimelineEvent } from '../src/shared/backgroundJobTypes'

const noop = (): void => undefined
const theme = createTheme({
  components: { MuiDialog: { defaultProps: { disablePortal: true } } }
})
const shell = '```bash\nprintf "hello\\n"\n```'
const python = '~~~python\nfor value in [1, 2]:\n    print(value)\n~~~'
afterEach(() => setUiLanguage('en'))

function renderActions(text: string, assistant = true): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(
        ChatCodeActions,
        { onRunBash: noop, onCreateNotebook: async () => undefined },
        assistant
          ? createElement(ChatBubble, {
              message: { id: 'assistant', role: 'assistant', content: text },
              onGoSettings: noop,
              onOpenBackgroundJobs: noop
            })
          : createElement(MarkdownContent, { text })
      )
    )
  )
}

test('only closed, supported assistant fences show actions alongside Copy', () => {
  assert.match(renderActions(shell), />Run<\/button>/)
  assert.match(renderActions(shell), />Copy<\/button>/)
  assert.match(renderActions(python), />Create Notebook<\/button>/)
  assert.doesNotMatch(renderActions(shell.replace('bash', 'console')), />Run<\/button>/)
  assert.doesNotMatch(renderActions(shell.slice(0, -3)), />Run<\/button>/)
  assert.doesNotMatch(renderActions(shell.slice(0, -3) + '> ```'), />Run<\/button>/)
  assert.doesNotMatch(renderActions(shell.slice(0, -3) + '    ```'), />Run<\/button>/)
  assert.doesNotMatch(renderActions(shell.replace('bash', '')), />Run<\/button>/)
  assert.doesNotMatch(renderActions(shell, false), />Run<\/button>/)
  assert.match(renderActions('> ' + shell.split('\n').join('\n> ')), />Run<\/button>/)
  setUiLanguage('zh-CN')
  assert.match(renderActions(shell), />运行<\/button>/)
  assert.match(renderActions(python), />创建 Notebook<\/button>/)
})

test('the command confirmation shows the original directory and treats shell text as plain text', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme },
      createElement(ChatShellConfirmation, {
        cwd: 'cluster:/project',
        command: 'printf "<b>sample</b>"',
        onClose: noop,
        onRun: noop
      })
    )
  )
  assert.match(markup, /cluster:\/project/)
  assert.match(markup, /&lt;b&gt;sample&lt;\/b&gt;/)
  assert.match(markup, /Cancel/)
})

test('live and restored shell results update the original card and ignore stale running status', () => {
  const started = {
    type: 'shell_job_started',
    shellJobLaunchId: 'app-launch',
    shellJob: {
      agentSessionId: 'origin',
      jobId: 'job-1',
      sessionId: 'session',
      sessionPath: '/session',
      sessionTitle: 'Session',
      command: 'exit 7',
      state: 'running',
      startedAt: '2026-11-06T00:00:00Z'
    }
  } satisfies ShellJobTimelineEvent
  const finished = {
    type: 'shell_job_finished',
    shellJob: {
      ...started.shellJob,
      state: 'failed',
      exitCode: 7,
      output: 'test output'
    }
  } satisfies ShellJobTimelineEvent

  const events = [started, finished, started]
  const live = events.reduce(reduceAgentEventState, createAgentEventReducerState()).messages
  const restored = chatItemsFromSessionMessages(
    events.map((event) => ({ source: 'phi', ...event }))
  )
  assert.deepEqual(restored, live)
  assert.equal(live.length, 1)
  assert.equal(live[0].role, 'warning')
  assert.equal(live[0].shellJob?.exitCode, 7)
  assert.equal(live[0].shellJob?.output, 'test output')
})
