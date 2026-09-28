import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ModelRegistry,
  SessionManager,
  Settings,
  discoverAuthStorage
} from '@oh-my-pi/pi-coding-agent'
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager
} from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'

import {
  createRemoteProjectToolGuardExtension,
  remoteWorkspaceToolsVerified
} from '../../src/main/agent/agents/remote-project-tool-guard'
import { createRemoteUrlGuardExtension } from '../../src/main/agent/agents/remote-url-guard'
import { buildRemoteWorkspaceReadTool } from '../../src/main/agent/remote-workspace-read-tool'
import { buildRemoteWorkspaceWriteTool } from '../../src/main/agent/remote-workspace-write-tool'
import { buildRemoteWorkspaceEditTool } from '../../src/main/agent/remote-workspace-edit-tool'
import { buildRemoteWorkspaceBashTool } from '../../src/main/agent/remote-workspace-bash-tool'
import {
  buildRemoteWorkspaceGlobTool,
  buildRemoteWorkspaceGrepTool
} from '../../src/main/agent/remote-workspace-search-tools'

const agentDir = mkdtempSync(join(tmpdir(), 'phi-remote-omp-smoke-'))
try {
  const authStorage = await discoverAuthStorage(agentDir)
  const settings = await Settings.init({ cwd: agentDir, agentDir })
  let remoteContent = 'remote-only'
  const tools = [
    buildRemoteWorkspaceReadTool(async () => ({
      kind: 'file',
      path: 'ssh://cluster-a/project/note.txt',
      content: remoteContent,
      fileSize: Buffer.byteLength(remoteContent),
      contentType: 'text/plain'
    })),
    buildRemoteWorkspaceWriteTool(async () => ({
      status: 'created',
      path: 'ssh://cluster-a/project/new.txt',
      bytes: 3
    })),
    buildRemoteWorkspaceEditTool(async (_toolCallId, input) => {
      const oldText = remoteContent
      if (!oldText.includes(input.old_string)) throw new Error('stale')
      remoteContent = oldText.replace(input.old_string, input.new_string)
      return {
        status: 'updated',
        path: 'ssh://cluster-a/project/note.txt',
        bytes: Buffer.byteLength(remoteContent),
        oldText,
        newText: remoteContent,
        diff: `-${oldText}\n+${remoteContent}`
      }
    }),
    buildRemoteWorkspaceBashTool(async () => ({
      status: 'completed',
      hostAlias: 'cluster-a',
      cwd: '/project',
      exitCode: 0,
      stdout: remoteContent,
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      wallTimeMs: 1
    })),
    buildRemoteWorkspaceGlobTool(async () => ({
      paths: ['ssh://cluster-a/project/note.txt'],
      content: 'remote-only',
      truncated: false,
      engine: 'rg',
      gitignoreApplied: true
    })),
    buildRemoteWorkspaceGrepTool(async () => ({
      matches: [],
      content: 'remote-only',
      fileCount: 0,
      matchCount: 0,
      truncated: false,
      engine: 'rg',
      gitignoreApplied: true
    }))
  ]
  const result = await createAgentSession({
    agentId: 'phi-remote-smoke',
    agentDisplayName: 'Smoke',
    cwd: agentDir,
    agentDir,
    settings,
    authStorage,
    modelRegistry: new ModelRegistry(authStorage),
    sessionManager: SessionManager.inMemory(agentDir),
    customTools: tools,
    toolNames: tools.map((tool) => tool.name),
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    enableMCP: false,
    enableLsp: false,
    extensions: [createRemoteProjectToolGuardExtension()]
  })
  await initializeExtensions(result.session, {
    reportSendError: () => undefined,
    reportRuntimeError: () => undefined
  })
  const infos = result.session.getAllToolInfos()
  const names = tools.map((tool) => tool.name)
  const verified = remoteWorkspaceToolsVerified(infos)
  if (!verified) throw new Error('SDK did not replace every built-in remote tool')
  if (remoteWorkspaceToolsVerified(infos.filter((info) => info.name !== 'read'))) {
    throw new Error('Missing remote read did not fail closed')
  }
  const activeTools = (
    result.session as unknown as {
      agent: {
        state: {
          tools: Array<{
            name: string
            execute: (
              id: string,
              input: unknown,
              signal: AbortSignal
            ) => Promise<{
              content: Array<{ type: string; text?: string }>
            }>
          }>
        }
      }
    }
  ).agent.state.tools
  const read = activeTools.find((tool) => tool.name === 'read')
  const edit = activeTools.find((tool) => tool.name === 'edit')
  const bash = activeTools.find((tool) => tool.name === 'bash')
  if (!read || !edit || !bash) throw new Error('SDK has no active remote tool')
  const readResult = await read.execute('call', { path: 'note.txt' }, new AbortController().signal)
  if (readResult.content[0]?.text !== 'remote-only') {
    throw new Error('SDK invoked a local read tool instead of the remote override')
  }
  await edit.execute(
    'edit-call',
    {
      path: 'note.txt',
      old_string: 'remote-only',
      new_string: 'main-updated'
    },
    new AbortController().signal
  )
  const afterMain = await read.execute(
    'read-again',
    { path: 'note.txt' },
    new AbortController().signal
  )
  if (afterMain.content[0]?.text !== 'main-updated')
    throw new Error('Main edit did not reach remote tool')
  const mainBash = await bash.execute(
    'bash-call',
    { command: 'cat note.txt' },
    new AbortController().signal
  )
  if (!mainBash.content[0]?.text?.includes('main-updated'))
    throw new Error('Main Bash did not reach remote tool')
  const specialistControlTools = [
    'wrapper_search',
    'wrapper_inspect',
    'wrapper_run',
    'wrapper_status',
    'wrapper_wait',
    'wrapper_cancel'
  ].map((name) => ({
    name,
    label: name,
    description: `Phi bundled catalog ${name}`,
    loadMode: 'essential' as const,
    approval:
      name === 'wrapper_run' || name === 'wrapper_cancel' ? ('write' as const) : ('read' as const),
    parameters: { type: 'object' as const, properties: {} },
    async execute() {
      return { content: [{ type: 'text' as const, text: 'catalog-only' }] }
    }
  }))
  const specialistLoader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.create(agentDir, agentDir),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createRemoteProjectToolGuardExtension()]
  })
  await specialistLoader.reload()
  const specialist = await createAgentSession({
    agentId: 'phi-remote-wrapper-smoke',
    agentDisplayName: 'Wrapper',
    cwd: agentDir,
    agentDir,
    settings,
    authStorage,
    modelRegistry: new ModelRegistry(authStorage),
    sessionManager: SessionManager.inMemory(agentDir),
    customTools: [...tools, ...specialistControlTools],
    resourceLoader: specialistLoader,
    toolNames: [...names, ...specialistControlTools.map((tool) => tool.name)],
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    enableMCP: false,
    enableLsp: false,
    extensions: [createRemoteUrlGuardExtension()]
  })
  await initializeExtensions(specialist.session, {
    reportSendError: () => undefined,
    reportRuntimeError: () => undefined
  })
  const specialistNames = specialist.session.getAllToolInfos().map((info) => info.name)
  for (const name of [...names, ...specialistControlTools.map((tool) => tool.name)]) {
    if (!specialistNames.includes(name)) throw new Error(`Specialist lost ${name}`)
  }
  for (const name of ['powershell', 'ast_edit']) {
    if (specialistNames.includes(name)) throw new Error(`Specialist exposed ${name}`)
  }
  const specialistTools = (
    specialist.session as unknown as {
      agent: { state: { tools: typeof activeTools } }
    }
  ).agent.state.tools
  const specialistRead = specialistTools.find((tool) => tool.name === 'read')
  const specialistEdit = specialistTools.find((tool) => tool.name === 'edit')
  const specialistBash = specialistTools.find((tool) => tool.name === 'bash')
  if (!specialistRead || !specialistEdit || !specialistBash)
    throw new Error('Specialist lost remote tools')
  const beforeSpecialist = await specialistRead.execute(
    'specialist-read',
    { path: 'note.txt' },
    new AbortController().signal
  )
  if (beforeSpecialist.content[0]?.text !== 'main-updated')
    throw new Error('Specialist read was local')
  await specialistEdit.execute(
    'specialist-edit',
    {
      path: 'note.txt',
      old_string: 'main-updated',
      new_string: 'specialist-updated'
    },
    new AbortController().signal
  )
  const afterSpecialist = await specialistRead.execute(
    'specialist-read-again',
    { path: 'note.txt' },
    new AbortController().signal
  )
  if (afterSpecialist.content[0]?.text !== 'specialist-updated')
    throw new Error('Specialist edit was local')
  const specialistBashResult = await specialistBash.execute(
    'specialist-bash',
    { command: 'cat note.txt' },
    new AbortController().signal
  )
  if (!specialistBashResult.content[0]?.text?.includes('specialist-updated'))
    throw new Error('Specialist Bash was local')
  if (existsSync(join(agentDir, 'note.txt'))) throw new Error('Local session anchor was modified')
  process.stdout.write(
    JSON.stringify({
      verified: names,
      read: readResult.content[0]?.text,
      main: afterMain.content[0]?.text,
      specialistRead: afterSpecialist.content[0]?.text,
      specialist: specialistNames
    }) + '\n'
  )
  await specialist.session.dispose()
  await result.session.dispose()
} finally {
  rmSync(agentDir, { recursive: true, force: true })
}
