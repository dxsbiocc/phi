import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { toolTargetFromArgs } from '../src/renderer/src/lib/toolTargets'
import { RemoteProjectFileContext } from '../src/renderer/src/lib/remoteProjectFileContext'
import { ToolCallDetail } from '../src/renderer/src/components/tool-call/ToolCallDetail'
import type { ToolCallItem } from '../src/renderer/src/types'

test('toolTargetFromArgs extracts edit and write targets', () => {
  assert.deepEqual(
    toolTargetFromArgs('edit', '{"path":"./src/App.tsx"}', '/Users/example/project'),
    {
      label: './src/App.tsx',
      absolutePath: '/Users/example/project/src/App.tsx'
    }
  )
  assert.deepEqual(
    toolTargetFromArgs('write', '{"file_path":"/Users/example/project/README.md"}', ''),
    {
      label: '/Users/example/project/README.md',
      absolutePath: '/Users/example/project/README.md'
    }
  )
})

test('toolTargetFromArgs ignores non-file tools and invalid paths', () => {
  assert.equal(toolTargetFromArgs('shell', '{"path":"./src/App.tsx"}', '/Users/example'), null)
  assert.deepEqual(toolTargetFromArgs('edit', '{"path":"src/App.tsx"}', '/Users/example'), {
    label: 'src/App.tsx',
    absolutePath: '/Users/example/src/App.tsx'
  })
  assert.equal(toolTargetFromArgs('write', '{bad json', '/Users/example'), null)
  assert.deepEqual(
    toolTargetFromArgs('write', '{"path":"note.txt"}', '/data/project', {
      allowBareFileName: true
    }),
    { label: 'note.txt', absolutePath: '/data/project/note.txt' }
  )
})

test('remote write tool card opens its SSH target in the file panel instead of Finder', () => {
  const item: ToolCallItem = {
    id: 'tool-1',
    role: 'tool',
    toolName: 'write',
    status: 'done',
    argsPreview: 'note.txt',
    argsJson: '{"path":"note.txt","content":"new"}',
    output: 'Updated remote file ssh://cluster-a/data/project/note.txt'
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(
        RemoteProjectFileContext.Provider,
        {
          value: {
            hostAlias: 'cluster-a',
            canonicalRoot: '/data/project',
            openPath: () => undefined
          }
        },
        createElement(ToolCallDetail, { item, cwd: '/data/project' })
      )
    )
  )
  assert.match(markup, /在文件面板打开/)
  assert.match(markup, /ssh:\/\/cluster-a\/data\/project\/note\.txt/)
  assert.doesNotMatch(markup, /在文件夹显示/)
})
