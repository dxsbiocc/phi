import { runCursorChildScenario, type CursorChildMode } from './rpcCursorChildScenarios'

const mode = process.env.PHI_CURSOR_CHILD_MODE ?? 'text'
if (!['text', 'repeat', 'tool', 'stop', 'parallel', 'queued-stop'].includes(mode))
  throw new Error('Unknown Cursor child recovery scenario')
await runCursorChildScenario(mode as CursorChildMode)
