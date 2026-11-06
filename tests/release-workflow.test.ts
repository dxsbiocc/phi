import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parse } from 'yaml'

type Step = {
  name?: string
  uses?: string
  run?: string
  if?: string
  shell?: string
  env?: Record<string, string>
}
type Job = {
  needs?: string | string[]
  if?: string
  permissions?: Record<string, string>
  strategy?: { matrix?: { include?: Array<Record<string, string>> } }
  steps?: Step[]
}

const workflowText = readFileSync('.github/workflows/release.yml', 'utf8')
const workflow = parse(workflowText) as {
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  jobs?: Record<string, Job>
}

test('releases are drafted only from version tags, never published automatically', () => {
  assert.deepEqual(Object.keys(workflow.on ?? {}).sort(), [
    'pull_request',
    'push',
    'workflow_dispatch'
  ])
  assert.deepEqual(workflow.on?.push, { tags: ['v*'] })
  assert.deepEqual(workflow.permissions, { contents: 'read' })

  const draft = workflow.jobs?.['draft-release']
  assert.equal(draft?.if, "startsWith(github.ref, 'refs/tags/v')")
  assert.deepEqual(draft?.permissions, { contents: 'write' })
  const create = draft?.steps?.find((step) => step.name === 'Create draft release')
  assert.match(create?.run ?? '', /gh release create "\$GITHUB_REF_NAME"/)
  assert.match(create?.run ?? '', /--draft/)
  // Hand-written notes for the tag win over generated ones, which list only merged PRs.
  assert.match(create?.run ?? '', /docs\/release-notes\/\$GITHUB_REF_NAME\.md/)
  assert.match(create?.run ?? '', /--notes-file/)
  // Only the draft job may write; packaging jobs stay read-only.
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    if (name !== 'draft-release') assert.equal(job.permissions, undefined, name)
  }
  const verify = workflow.jobs?.verify?.steps?.find((step) => step.name?.startsWith('Tag matches'))
  assert.match(verify?.run ?? '', /package\.json/)
})

test('packages macOS arm64, Linux x64, and Windows x64, smoke-testing the bundled worker on each', () => {
  const pkg = workflow.jobs?.package
  assert.deepEqual(
    pkg?.strategy?.matrix?.include?.map((entry) => [entry.os, entry.builder]),
    [
      ['macos-15', '--mac dmg zip --arm64'],
      ['ubuntu-22.04', '--linux AppImage deb --x64'],
      ['windows-2022', '--win nsis --x64']
    ]
  )
  const steps = pkg?.steps ?? []
  // The kernel is the default route: a package without it cannot run a single session.
  const buildKernel = steps.findIndex((step) => step.run?.includes('build-kernel.ts'))
  const builderStep = steps.findIndex((step) => step.run?.includes('electron-builder'))
  assert.ok(buildKernel >= 0 && buildKernel < builderStep)
  const smoke = steps.find((step) => step.run?.includes('smoke-packaged-worker.mjs'))
  assert.ok(smoke, 'packaged worker smoke test runs')
  assert.equal(smoke?.if, "runner.os != 'Windows'")
  assert.match(smoke?.run ?? '', /dist\/mac-arm64\/Phi\.app\/Contents\/Resources/)
  assert.match(smoke?.run ?? '', /dist\/linux-unpacked\/resources/)
  assert.match(workflowText, /dist\/\*\.exe/)
  const packageStep = steps.find((step) => step.name === 'Package')
  assert.match(packageStep?.run ?? '', /--publish never/)
  // Empty secrets would be read as a certificate path.
  assert.match(packageStep?.run ?? '', /\[ -n "\$\{!name\}" \] \|\| unset "\$name"/)
})

test('Windows release verifies the installed NSIS app before uploading artifacts', () => {
  const steps = workflow.jobs?.package?.steps ?? []
  const install = steps.find((step) => step.name === 'Install and smoke-test Windows NSIS package')
  assert.equal(install?.if, "runner.os == 'Windows'")
  assert.equal(install?.shell, 'pwsh')
  assert.match(install?.run ?? '', /Join-Path \$env:RUNNER_TEMP/)
  assert.match(
    install?.run ?? '',
    /-ArgumentList "\/S \/currentuser \/D=\$installDir" -Wait -PassThru/
  )
  assert.match(install?.run ?? '', /\$process\.ExitCode -ne 0/)
  assert.match(install?.run ?? '', /\$app = Join-Path \$installDir 'phi\.exe'/)
  assert.match(install?.run ?? '', /Test-Path -LiteralPath \$app/)
  assert.match(install?.run ?? '', /\$resources = Join-Path \$installDir 'resources'/)
  assert.match(install?.run ?? '', /smoke-packaged-worker\.mjs --resources \$resources/)
  assert.match(install?.run ?? '', /check-release-kernel\.ts --resources \$resources/)
  assert.match(install?.run ?? '', /smoke-installed-desktop\.ts --app \$app/)
  const uploadIndex = steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact@'))
  assert.ok(install && steps.indexOf(install) < uploadIndex)
  const builder = parse(readFileSync('electron-builder.yml', 'utf8')) as {
    nsis?: { perMachine?: boolean }
  }
  assert.equal(builder.nsis?.perMachine, false)
})

test('local and CI Windows builds prepare the same native and WSL runtimes before packaging', () => {
  const scripts = (
    JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts
  const steps = workflow.jobs?.package?.steps ?? []
  const prepareIndex = steps.findIndex((step) => step.run === 'bun run runtime:fetch:win')
  const packageIndex = steps.findIndex((step) => step.name === 'Package')
  assert.ok(prepareIndex >= 0 && prepareIndex < packageIndex)
  assert.equal(steps[prepareIndex].if, "runner.os == 'Windows'")
  assert.match(scripts['build:win'], /bun run runtime:fetch:win.*electron-builder --win --x64/)
  assert.match(scripts['runtime:fetch:win'], /fetch-micromamba\.mjs --platform win32-x64/)
  assert.match(scripts['runtime:fetch:win'], /fetch-micromamba\.mjs --platform linux-x64/)
  assert.match(scripts['runtime:fetch:win'], /fetch-bun\.mjs --platform win32-x64/)
})

test('POSIX release jobs reuse the installed Electron and prepare a verified 7-Zip', () => {
  const steps = workflow.jobs?.package?.steps ?? []
  const inputs = steps.find((step) => step.name === 'Prepare native packaging inputs')
  const packaging = steps.find((step) => step.name === 'Package')
  assert.ok(inputs && packaging && steps.indexOf(inputs) < steps.indexOf(packaging))
  assert.equal(inputs.if, "runner.os != 'Windows'")
  assert.match(inputs.run ?? '', /node node_modules\/electron\/install\.js\n[\s\S]*dist=/)
  assert.match(inputs.run ?? '', /node_modules\/electron\/dist/)
  assert.match(inputs.run ?? '', /require\('electron\/package.json'\)\.version/)
  assert.match(inputs.run ?? '', /fetch-builder-7zip\.sh/)
  assert.match(inputs.run ?? '', /ELECTRON_BUILDER_7ZIP_PATH/)
  assert.match(packaging.run ?? '', /-c\.electronDist=\$PHI_RELEASE_ELECTRON_DIST/)
})

test('release packaging retries a gateway failure and preserves deterministic failures', () => {
  const packaging = workflow.jobs?.package?.steps?.find((step) => step.name === 'Package')
  assert.ok(packaging?.run)
  const command = packaging.run.replace('${{ matrix.builder }}', '--linux AppImage deb --x64')
  for (const [message, exitCode, attempts] of [
    ['Response code 504 (Gateway Time-out)', 0, 2],
    ['Signature verification failed', 17, 1]
  ] as const) {
    const result = spawnSync(
      'bash',
      [
        '-e',
        '-o',
        'pipefail',
        '-c',
        `npx() {
          echo "Builder attempt $attempt"
          if (( attempt > 1 )); then return 0; fi
          echo "$PHI_TEST_BUILDER_ERROR" >&2
          return 17
        }
        sleep() { :; }
        ${command}`
      ],
      {
        env: {
          ...process.env,
          RUNNER_OS: 'Linux',
          SIGNING_ARGS: '',
          PHI_TEST_BUILDER_ERROR: message
        },
        encoding: 'utf8'
      }
    )
    assert.equal(result.status, exitCode, result.error?.message ?? result.stderr)
    assert.equal(result.stdout.match(/Builder attempt/g)?.length, attempts)
  }
})

test('Windows interactive installer offers a directory picker and defaults to the current user', () => {
  const builder = parse(readFileSync('electron-builder.yml', 'utf8')) as {
    nsis?: {
      oneClick?: boolean
      allowToChangeInstallationDirectory?: boolean
      perMachine?: boolean
      selectPerMachineByDefault?: boolean
    }
  }
  assert.equal(builder.nsis?.oneClick, false)
  assert.equal(builder.nsis?.allowToChangeInstallationDirectory, true)
  assert.equal(builder.nsis?.perMachine, false)
  assert.equal(builder.nsis?.selectPerMachineByDefault, false)
})

test('macOS signing uses a certificate when configured and ad-hoc signing otherwise', () => {
  const steps = workflow.jobs?.package?.steps ?? []
  const choose = steps.find((step) => step.name === 'Choose macOS signing')
  assert.equal(choose?.if, "runner.os == 'macOS'")
  assert.match(choose?.run ?? '', /-c\.mac\.identity=- -c\.mac\.hardenedRuntime=false/)
  assert.match(choose?.run ?? '', /-c\.mac\.notarize=true/)
  // Forced only in the ad-hoc branch, which uses no secrets.
  const adHoc = (choose?.run ?? '').split('else')[1] ?? ''
  assert.match(adHoc, /CSC_FOR_PULL_REQUEST=true/)
  assert.doesNotMatch((choose?.run ?? '').split('else')[0] ?? '', /CSC_FOR_PULL_REQUEST/)
  const verify = steps.find((step) => step.name === 'Check macOS signature')
  assert.match(verify?.run ?? '', /codesign --verify --deep --strict/)
  // Secrets reach the tools through env only; nothing prints them.
  assert.equal(/echo[^\n]*secrets\./.test(workflowText), false)
  assert.equal(
    /echo[^\n]*\$(CSC_KEY_PASSWORD|APPLE_APP_SPECIFIC_PASSWORD)/.test(workflowText),
    false
  )
})

test('local packaging scripts never publish, even on CI', () => {
  const scripts = (
    JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts
  for (const name of ['build:unpack', 'build:win', 'build:mac', 'build:linux']) {
    assert.match(scripts[name] ?? '', /electron-builder .*--publish never$/, name)
  }
})

test('the app build gets enough heap for the macOS runners', () => {
  const build = workflow.jobs?.package?.steps?.find((step) => step.name === 'Build app')
  assert.equal(build?.env?.NODE_OPTIONS, '--max-old-space-size=4096')
})
