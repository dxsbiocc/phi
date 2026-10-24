#!/usr/bin/env bun
// E5 preflight and isolated local preparation. Neither mode launches Phi or a model.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  E5_PROJECT_ID,
  prepareE5Profile,
  readE5Model,
  readE5Project,
  type E5PreparedProfile
} from './e5-smoke-profile'

const exec = promisify(execFile)
const SOURCE_AGENT_DIR = join(homedir(), '.phi')
const HOST = 'GPU'

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function preflight(): Promise<void> {
  const project = await readE5Project(SOURCE_AGENT_DIR)
  const model = await readE5Model(SOURCE_AGENT_DIR, project)
  const root = project.location.remoteRoot!
  const canonical = project.location.canonicalRoot!
  const command = [
    `cd -P -- ${quote(root)} || exit 30`,
    'test -r . && test -w . || exit 31',
    'pwd -P'
  ].join(' && ')
  const result = await exec(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UpdateHostKeys=no',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'PermitLocalCommand=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'ConnectionAttempts=1',
      '-o',
      'ConnectTimeout=10',
      '-T',
      HOST,
      command
    ],
    { timeout: 20_000, maxBuffer: 4096 }
  )
  if (result.stdout.trim() !== canonical)
    throw new Error('SSH canonical root differs from the saved project binding')
  console.log(
    JSON.stringify(
      {
        status: 'preflight-only',
        project: 'phi-test',
        projectId: E5_PROJECT_ID,
        sshAlias: HOST,
        model: `${model.providerId}/${model.modelId}`,
        modelReadiness: 'unverified until the isolated test profile is prepared',
        remoteRoot: '[verified; redacted]',
        remoteAccess: 'read/write directory permissions verified without creating files'
      },
      null,
      2
    )
  )
}

async function prepare(): Promise<void> {
  const profile = await prepareE5Profile(SOURCE_AGENT_DIR)
  const command = e5LaunchCommand(profile)
  console.log(
    JSON.stringify(
      {
        status: 'prepared-only',
        root: profile.root,
        projectId: E5_PROJECT_ID,
        model: `${profile.model.providerId}/${profile.model.modelId}`,
        modelReadiness: 'unverified; no credentials were copied',
        launchCommand: command,
        note: 'GPU SSH alias uses a generated minimal config and the current SSH agent; no private key or Phi credential was copied. Model login must happen inside the isolated window. No app or model was started.'
      },
      null,
      2
    )
  )
}

/** Bun consumes the first `--`; electron-vite needs the second for options['--']. */
export function e5LaunchCommand(
  profile: Pick<E5PreparedProfile, 'homeDir' | 'agentDir' | 'userDataDir'>,
  cwd = process.cwd(),
  bunPath = process.execPath,
  pathEnv = process.env.PATH ?? '/usr/bin:/bin'
): string {
  const command = [
    `cd ${quote(cwd)} &&`,
    'env -i',
    `PATH=${quote(pathEnv)}`,
    `HOME=${quote(profile.homeDir)}`,
    `PI_CODING_AGENT_DIR=${quote(profile.agentDir)}`,
    'SSH_AUTH_SOCK="${SSH_AUTH_SOCK-}"',
    `${quote(bunPath)} run dev -- -- --e5-smoke --user-data-dir=${quote(profile.userDataDir)}`
  ].join(' ')
  return command
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv.slice(2).join(' ')
  if (action !== '--preflight' && action !== '--prepare') {
    console.error('Usage: bun scripts/e5-phi-test-smoke.ts --preflight|--prepare')
    process.exitCode = 2
  } else {
    await (action === '--preflight' ? preflight() : prepare()).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `E5 ${action} failed: ${message.startsWith('Command failed:') ? 'SSH check failed (command and paths redacted)' : message}`
      )
      process.exitCode = 1
    })
  }
}
