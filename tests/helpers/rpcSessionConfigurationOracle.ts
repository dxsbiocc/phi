import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rpcSessionSelectionOracle } from './rpcSessionSelectionOracle'

type SelectionOracle = Awaited<ReturnType<typeof rpcSessionSelectionOracle>>

export interface ConfigurationObservation {
  type: string
  prompt?: string
  base?: string[]
  current?: string[]
}

export const CONFIGURATION_PERSONA = 'PERSONA-CONTRACT: explain scientific evidence concisely.'
export const CONFIGURATION_PROJECT_RULE = 'PROJECT-CONTRACT: preserve the original research inputs.'
export const CONFIGURATION_FOREIGN_RULE = 'FOREIGN-CONTEXT-CONTRACT: this is an implicit disk rule.'
export const CONFIGURATION_REMOTE_ROOT = '/srv/phi/configuration-contract'

/** Real CLI and desktop gateway, with a test-only consumer of public extension hooks. */
export async function rpcSessionConfigurationOracle(options: { injectPhi: boolean }): Promise<{
  selection: SelectionOracle
  prompt(text: string): ReturnType<SelectionOracle['connection']['prompt']>
  observations(): Promise<ConfigurationObservation[]>
  reload(): Promise<void>
  reopen(): Promise<void>
  close(): Promise<void>
}> {
  const selection = await rpcSessionSelectionOracle()
  try {
    // Official CLI journals are created lazily. This initial turn precedes the
    // configuration under test and is excluded from the recorded requests.
    selection.base.provider.enqueue({ text: 'Configuration oracle initialized.' })
    const initialized = await selection.connection.prompt('Initialize the configuration oracle.')
    if (initialized.status !== 'completed') throw new Error('Configuration initialization failed')
    const sessionFile = (await selection.state()).sessionFile
    const observationPath = join(selection.base.root, 'configuration-observations.jsonl')
    const policyPath = join(selection.base.root, 'configuration-policy.json')
    const configPath = join(selection.base.agentDir, 'config.yml')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.includeWorkspaceTree = false
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    await writeFile(join(selection.base.cwd, 'AGENTS.md'), CONFIGURATION_PROJECT_RULE, {
      mode: 0o600
    })
    // Github's context provider has higher priority than standalone AGENTS at
    // the same directory depth. The baseline pins that native shadowing rule.
    await mkdir(join(selection.base.cwd, '.github'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(selection.base.cwd, '.github', 'copilot-instructions.md'),
      CONFIGURATION_FOREIGN_RULE,
      { mode: 0o600 }
    )
    await writeFile(observationPath, '', { mode: 0o600 })
    await writeFile(
      policyPath,
      JSON.stringify({
        injectPhi: options.injectPhi,
        persona: CONFIGURATION_PERSONA,
        projectRule: CONFIGURATION_PROJECT_RULE,
        remoteRoot: CONFIGURATION_REMOTE_ROOT,
        anchor: selection.base.cwd
      }),
      { mode: 0o600 }
    )
    const promptBuilder = pathToFileURL(
      join(process.cwd(), 'src/main/agent/main-system-prompt.ts')
    ).href
    await writeFile(
      join(selection.base.root, 'selection-refresh-extension.ts'),
      `import { appendFileSync, readFileSync } from 'node:fs';
import { buildPhiRemoteProjectSystemPrompt } from ${JSON.stringify(promptBuilder)};
const policy = JSON.parse(readFileSync(${JSON.stringify(policyPath)}, 'utf8'));
const record = value => appendFileSync(${JSON.stringify(observationPath)}, JSON.stringify(value) + '\\n', {mode:0o600});
export default pi => {
  pi.on('session_start', () => record({type:'session_start'}));
  pi.on('before_agent_start', async (event, ctx) => {
    record({type:'before_agent_start', prompt:event.prompt, base:event.systemPrompt, current:ctx.getSystemPrompt()});
    if (!policy.injectPhi) return;
    const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
    if (!session) throw new Error('The real session is unavailable');
    const tools = pi.getActiveTools().map(name=>session.getToolByName(name));
    if (tools.some(tool=>!tool)) throw new Error('An active tool is missing');
    const rebuilt = await pi.pi.buildSystemPrompt({
      tools, skills:[], cwd:ctx.cwd, customPrompt:'', appendPrompt:'', includeWorkspaceTree:false,
      contextFiles:[{path:policy.remoteRoot+'/AGENTS.md', content:policy.projectRule}]
    });
    record({type:'trusted_rebuild',base:rebuilt.systemPrompt});
    return {systemPrompt:buildPhiRemoteProjectSystemPrompt(rebuilt.systemPrompt, policy.anchor, policy.remoteRoot, {personaMarkdown:policy.persona})};
  });
  pi.registerCommand('configuration-oracle-reload', {
    description:'Exercise the public reload boundary without a model request',
    handler:async (_args,ctx) => { await ctx.reload(); }
  });
};`,
      { mode: 0o600 }
    )
    await selection.reopen(sessionFile)
    // A restored transcript can retain its original prompt-context snapshot.
    // Create the session under test after placing its fixture files, exercising
    // real discovery rather than the initialized journal's existing context.
    const created = await selection.connection.request<{ cancelled: boolean }>({
      type: 'new_session'
    })
    if (created.cancelled) throw new Error('Configured session creation was cancelled')
    selection.base.provider.requests.length = 0
    const observations = async (): Promise<ConfigurationObservation[]> => {
      const content = (await readFile(observationPath, 'utf8')).trim()
      return content ? content.split('\n').map((line) => JSON.parse(line)) : []
    }
    return {
      selection,
      async prompt(text) {
        selection.base.provider.enqueue({ text: 'The configured Phi response is complete.' })
        return selection.connection.prompt(text)
      },
      observations,
      async reload() {
        const result = await selection.connection.prompt('/configuration-oracle-reload')
        if (result.status !== 'completed' || result.agentInvoked)
          throw new Error('Public configuration reload did not settle as a command')
      },
      async reopen() {
        await selection.reopen((await selection.state()).sessionFile)
      },
      close: () => selection.close()
    }
  } catch (error) {
    await selection.close().catch(() => {})
    throw error
  }
}
