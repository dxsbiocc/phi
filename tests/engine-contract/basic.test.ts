import { basicEngineContract, type BasicEngineFixture } from './basic-suite'
import { createInProcessFixture } from './in-process-factory'

async function createBasicInProcessFixture(): Promise<BasicEngineFixture> {
  const fixture = await createInProcessFixture()
  return {
    provider: fixture.provider,
    params: (sessionId) => ({
      sessionId,
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      model: fixture.model
    }),
    onSessionEvent: (id, listener) => fixture.engine.events.onSessionEvent(id, listener),
    sessions: {
      create: (params) =>
        fixture.engine.sessions.create({
          ...params,
          sessionManager: { kind: 'memory', cwd: fixture.cwd },
          resourceOptions: {
            noExtensions: true,
            noSkills: true,
            noContextFiles: true,
            noPromptTemplates: true,
            noThemes: true
          },
          noTools: 'all',
          enableToolApproval: false,
          autoCompaction: { enabled: false }
        }),
      prompt: (params) => fixture.engine.sessions.prompt(params),
      abort: (params) => fixture.engine.sessions.abort(params),
      dispose: (params) => fixture.engine.sessions.dispose(params),
      has: (id) => fixture.engine.sessions.has(id)
    },
    close: () => fixture.close()
  }
}

basicEngineContract('InProcessEngine basic', createBasicInProcessFixture)
