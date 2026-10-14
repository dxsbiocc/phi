import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent'

// Test-only probe for a single synthetic variable. Never enumerates environment
// values or inspects a user .env/credential file.
const environmentProbe: ExtensionFactory = (pi) => {
  pi.registerCommand('phi-rpc-env-probe', {
    description: 'Phi synthetic startup environment probe',
    handler: async (nonce, ctx) => {
      ctx.ui.notify(
        JSON.stringify({
          type: 'phi_rpc_environment_probe',
          nonce,
          marker: process.env.PHI_RPC_DOTENV_TEST_MARKER ?? null,
          debug: process.env.PI_REQ_DEBUG ?? null,
          processCwd: process.cwd(),
          contextCwd: ctx.cwd
        }),
        'info'
      )
    }
  })
}
export default environmentProbe
