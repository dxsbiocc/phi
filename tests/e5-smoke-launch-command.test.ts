import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { e5LaunchCommand } from '../scripts/e5-phi-test-smoke'

test('E5 launch passes flags through Bun to the CLI after its separator', () => {
  const root = mkdtempSync('/tmp/phi-e5-bun-args-')
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { dev: 'node args.cjs --watch' }
      })
    )
    writeFileSync(
      join(root, 'args.cjs'),
      [
        'console.log(JSON.stringify({',
        '  argv: process.argv.slice(2),',
        '  home: process.env.HOME,',
        '  agentDir: process.env.PI_CODING_AGENT_DIR,',
        '  providerKey: process.env.MOONSHOT_API_KEY,',
        '  inheritedArgs: process.env.ELECTRON_CLI_ARGS',
        '}))'
      ].join('\n')
    )
    const bunPath = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
    const profile = {
      homeDir: join(root, 'home'),
      agentDir: join(root, 'home', '.phi'),
      userDataDir: join(root, 'user data')
    }
    const command = e5LaunchCommand(profile, root, bunPath)
    assert.equal(command.includes('ELECTRON_CLI_ARGS='), false)
    const output = execFileSync('/bin/zsh', ['-c', command], {
      encoding: 'utf8',
      env: { ...process.env, MOONSHOT_API_KEY: 'DO-NOT-INHERIT', ELECTRON_CLI_ARGS: '["wrong"]' }
    })
    const result = JSON.parse(output) as Record<string, unknown>
    assert.deepEqual(result.argv, [
      '--watch',
      '--',
      '--e5-smoke',
      `--user-data-dir=${profile.userDataDir}`
    ])
    assert.equal(result.home, profile.homeDir)
    assert.equal(result.agentDir, profile.agentDir)
    assert.equal(result.providerKey, undefined)
    assert.equal(result.inheritedArgs, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
