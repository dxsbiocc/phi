import { join } from 'path'
import { homedir } from 'os'

// Must be imported first, before any module that constructs a pi SDK
// object (AuthManager, session-manager) at its own module top level — ESM
// import evaluation runs those top-level side effects before the importing
// file's own body, so setting this env var later in index.ts is too late.
//
// pi-desktop owns its own config directory rather than sharing ~/.pi/agent
// with the pi CLI — concurrent writes to the same auth.json/sessions from two
// independent tools caused lock contention and flaky credential state.
// PI_CODING_AGENT_DIR is the SDK's official override (see config.js:getAgentDir)
// and redirects auth.json, models.json, sessions/, settings.json, etc. in one go.
process.env.PI_CODING_AGENT_DIR = join(homedir(), '.phi')
