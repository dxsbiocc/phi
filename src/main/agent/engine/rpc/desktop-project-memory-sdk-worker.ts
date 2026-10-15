import { createInterface } from 'node:readline'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getContext, modelBySelector } from '../in-process/runtime-context'
import { runImportedMemoryPipeline, silenceProjectMemorySdkLogging } from '../omp-internals'

// The SDK memory calls omit AbortSignal. This process belongs to one project job;
// parent EOF or termination closes its HTTP sockets without touching the shared worker.
silenceProjectMemorySdkLogging()
process.on('SIGTERM', () => process.exit(143))
process.stdin.once('end', () => process.exit(70))
const input = createInterface({ input: process.stdin })
let started = false
input.on('line', (line) => {
  if (started) {
    process.exit(65)
    return
  }
  started = true
  void (async () => {
    const raw = JSON.parse(line) as Record<string, unknown>
    if (
      Object.keys(raw).sort().join(',') !== 'agentDir,cwd,model,rolloutDir,stageAgentDir' ||
      ![raw.agentDir, raw.cwd, raw.rolloutDir, raw.stageAgentDir].every(
        (value) => typeof value === 'string' && value.startsWith('/')
      ) ||
      !raw.model ||
      typeof raw.model !== 'object'
    )
      throw new Error('Invalid memory worker startup')
    const model = raw.model as { provider: string; id: string }
    // CRUD uses the cwd as a namespace; only an actual companion launch needs it on disk.
    await realpath(raw.cwd as string)
    const context = await getContext(raw.agentDir)
    const selected = await modelBySelector(context, model)
    if (!selected) throw new Error('Memory model is unavailable')
    await mkdir(raw.stageAgentDir as string, { recursive: true, mode: 0o700 })
    const result = await runImportedMemoryPipeline({
      canonicalAgentDir: raw.agentDir as string,
      agentDir: raw.stageAgentDir as string,
      cwd: raw.cwd as string,
      directory: raw.rolloutDir as string,
      context,
      model: selected
    })
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n', () => process.exit(0))
  })().catch(async (error) => {
    // Diagnostic data stays private and is never returned through public RPC events.
    try {
      const raw = JSON.parse(line) as { stageAgentDir?: unknown }
      if (typeof raw.stageAgentDir === 'string')
        await writeFile(
          join(raw.stageAgentDir, 'pipeline-error.json'),
          JSON.stringify({ error: String(error) }),
          { mode: 0o600 }
        )
    } catch {
      /* An unavailable diagnostic path must not prevent termination. */
    }
    process.stdout.write(JSON.stringify({ ok: false, code: 'MEMORY_PIPELINE_FAILED' }) + '\n', () =>
      process.exit(1)
    )
  })
})
