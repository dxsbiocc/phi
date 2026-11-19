// Keep real provider credentials out of the test project, process environment and reports.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(import.meta.url)
const failureReason = {
  20: 'could not initialize the isolated SDK credential store',
  21: 'could not open the original Phi credential store read-only',
  22: 'could not select an enabled Moonshot API key',
  23: 'could not resolve the built-in kimi-k3 model and its credential offline'
}

export function prepareMoonshotCredential(profile) {
  assert.equal(process.env.PHI_DESKTOP_DRIVER, 'moonshot', 'Moonshot must be explicitly selected')
  const root = realpathSync(profile.root)
  assert.match(basename(root), /^phi-deseq2-desktop-[a-zA-Z0-9]+$/)
  assert.equal(statSync(root).mode & 0o077, 0, 'The lab root must be private to this user')
  assert.equal(realpathSync(profile.home), join(root, 'home'))
  assert.equal(realpathSync(profile.agentDir), join(root, 'home', '.phi'))
  const database = join(profile.agentDir, 'agent.db')
  // Exclusive creation scopes cleanup to this new lab's credential database.
  closeSync(openSync(database, 'wx', 0o600))
  let cleared = false
  function cleanup() {
    if (cleared) return
    process.off('exit', cleanup)
    for (const suffix of ['-wal', '-shm', '-journal', ''])
      rmSync(database + suffix, { force: true })
    cleared = true
  }
  process.once('exit', cleanup)
  const result = spawnSync('bun', [script, join(homedir(), '.phi', 'agent.db')], {
    env: {
      HOME: profile.home,
      PI_CODING_AGENT_DIR: profile.agentDir,
      TMPDIR: process.env.TMPDIR,
      PATH: process.env.PATH,
      PHI_DESKTOP_DRIVER: 'moonshot'
    },
    // SDK diagnostics must never enter the desktop report.
    stdio: 'ignore',
    timeout: 30_000
  })
  if (result.status !== 0) {
    cleanup()
    throw new Error(
      'Moonshot preparation failed: ' + (failureReason[result.status] ?? 'Bun did not complete')
    )
  }
  return cleanup
}

// Bun is the SDK runtime. SQLite transfers one enabled login inside an INSERT ... SELECT;
// the user's source database is attached read-only. No custom routing or model cache is copied.
if (
  process.versions.bun &&
  process.argv[1] === script &&
  process.env.PHI_DESKTOP_DRIVER === 'moonshot'
) {
  let stage = 20
  try {
    const { Database } = await import('bun:sqlite')
    const { AuthStorage, SqliteAuthCredentialStore } = await import('@oh-my-pi/pi-ai')
    const { ModelRegistry } = await import('@oh-my-pi/pi-coding-agent')
    const dir = process.env.PI_CODING_AGENT_DIR
    const database = join(dir, 'agent.db')
    const schema = await SqliteAuthCredentialStore.open(database)
    schema.close()
    const db = new Database(database)
    try {
      stage = 21
      db.query('ATTACH DATABASE ? AS original').run(
        pathToFileURL(process.argv[2]).href + '?mode=ro'
      )
      stage = 22
      db.query(
        `
        INSERT INTO main.auth_credentials (provider, credential_type, data, identity_key)
        SELECT provider, credential_type, data, identity_key FROM original.auth_credentials
        WHERE provider = 'moonshot' AND credential_type = 'api_key' AND disabled_cause IS NULL
          AND json_type(data, '$.key') = 'text' AND length(json_extract(data, '$.key')) > 0
        ORDER BY id LIMIT 1
      `
      ).run()
      assert.equal(db.query('SELECT count(*) AS n FROM main.auth_credentials').get().n, 1)
    } finally {
      db.close()
    }
    stage = 23
    const auth = await AuthStorage.create(database)
    try {
      await auth.credentials.reload()
      const registry = new ModelRegistry(auth, join(dir, 'models.yml'), {
        fetch: () => {
          throw new Error('Offline credential preparation')
        }
      })
      const model = registry.find('moonshot', 'kimi-k3')
      assert.equal(model?.api, 'openai-completions')
      assert(await registry.getApiKey(model), 'Built-in Moonshot model must resolve its API key')
    } finally {
      auth.close()
    }
  } catch {
    process.exitCode = stage
  }
}
