import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  computeEnvId,
  currentPlatform,
  ensureEnvironment,
  readEnvironmentIndex,
  removeTree,
  type EnvironmentSpec,
  type SourcePackage
} from '../src/main/agent/envs'
import {
  isReplacedSourcePackageLinkFailure,
  linkScriptFailureFromOutput,
  unreplacedLinkScriptFailureFromOutput
} from '../src/main/agent/envs/link-script-failures'

const SOURCE_PACKAGE: SourcePackage = {
  language: 'r',
  name: 'GenomeInfoDbData',
  source: 'github',
  repo: 'Bioconductor/GenomeInfoDbData',
  ref: 'b5339e03cc0c9c188e773a7ec2b80a146601595a',
  sha256: '1eccebf119d4de560b4f601eddb863436889630fdee3d0185f89e32ca4e14125'
}
const LOCK_TEXT =
  '@EXPLICIT\nhttps://conda.anaconda.org/bioconda/noarch/bioconductor-genomeinfodbdata-1.2.13-r44hdfd78af_0.tar.bz2#06d453df3bc59956a3ffac7674652f44\n'

function replacementSpec(name: string): EnvironmentSpec {
  return {
    name,
    channels: ['bioconda'],
    dependencies: ['bioconductor-genomeinfodbdata=1.2.13'],
    sourcePackages: [SOURCE_PACKAGE]
  }
}

function fakeMicromambaScript(): string {
  return `#!/bin/sh
command=
prefix=
previous=
for arg in "$@"; do
  if [ "$previous" = "-p" ]; then prefix="$arg"; fi
  if [ "$arg" = "create" ]; then command=create; fi
  if [ "$arg" = "run" ]; then command=run; fi
  if [ "$arg" = "--version" ]; then command=version; fi
  previous="$arg"
done
case "$command" in
  create)
    mkdir -p "$prefix/bin"
    printf "%s\\n" "warning  libmamba Executing post-link script for package 'bioconductor-genomeinfodbdata'." >&2
    printf "%s\\n" "/prefix/install.sh: line 7: yq: command not found" >&2
    ;;
  run)
    printf 'PATH=%s/bin:/usr/bin:/bin:/usr/sbin:/sbin\\0CONDA_PREFIX=%s\\0' "$prefix" "$prefix"
    ;;
  version)
    printf '2.9.0\\n'
    ;;
  *)
    exit 2
    ;;
esac
`
}

async function withFakeMicromamba(
  name: string,
  body: (root: string) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `phi-link-replacement-${name}-`))
  const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  const executable = join(root, 'runtime', 'micromamba', currentPlatform(), 'micromamba')
  mkdirSync(dirname(executable), { recursive: true })
  writeFileSync(executable, fakeMicromambaScript(), { mode: 0o755 })
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root })
  try {
    await body(root)
  } finally {
    if (resourcesPathDescriptor) {
      Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor)
    } else {
      Reflect.deleteProperty(process, 'resourcesPath')
    }
    removeTree(root)
  }
}

test('link-script replacement matching stays exact and does not hide later failures', () => {
  const failure = {
    action: 'post-link' as const,
    packageName: 'bioconductor-genomeinfodbdata',
    detail: 'yq: command not found'
  }
  assert.equal(isReplacedSourcePackageLinkFailure(failure, [SOURCE_PACKAGE]), true)
  assert.equal(
    isReplacedSourcePackageLinkFailure({ ...failure, action: 'pre-link' }, [SOURCE_PACKAGE]),
    false
  )
  assert.equal(
    isReplacedSourcePackageLinkFailure({ ...failure, packageName: 'r-foobar' }, [
      { ...SOURCE_PACKAGE, name: 'foo.bar' }
    ]),
    false
  )

  const laterFailure = unreplacedLinkScriptFailureFromOutput(
    [
      "warning  libmamba Executing post-link script for package 'bioconductor-genomeinfodbdata'.",
      '/prefix/install.sh: line 7: yq: command not found',
      "warning  libmamba Executing post-link script for package 'demo'.",
      '/prefix/demo.sh: line 3: helper: command not found'
    ].join('\n'),
    [SOURCE_PACKAGE]
  )
  assert.equal(laterFailure?.packageName, 'demo')
  assert.equal(
    linkScriptFailureFromOutput(
      "warning  libmamba Executing post-link script for package 'demo'.\noptional warning"
    ),
    undefined
  )
})

test('ensureEnvironment defers a replaced post-link and invokes its source installer', async () => {
  await withFakeMicromamba('success', async (root) => {
    const spec = replacementSpec('replacement-success')
    const phases: string[] = []
    let installed = false
    const result = await ensureEnvironment({
      root,
      scope: 'phi',
      kind: 'base',
      spec,
      lockText: LOCK_TEXT,
      sourcePackageInstaller: (prefix, packages) => {
        installed = true
        assert.equal(prefix, resultPrefix(root, spec))
        assert.deepEqual(packages, [SOURCE_PACKAGE])
      },
      onProgress: (event) => phases.push(`${event.phase}:${event.message}`)
    })

    assert.equal(installed, true)
    assert.equal(result.metadata.status, 'ready')
    assert.ok(phases.some((phase) => phase.includes('deferring failed')))
    assert.ok(phases.some((phase) => phase.startsWith('source-packages:')))
  })
})

test('a rejected replacement installer still removes the prefix and records failure', async () => {
  await withFakeMicromamba('failure', async (root) => {
    const spec = replacementSpec('replacement-failure')
    const prefix = resultPrefix(root, spec)
    await assert.rejects(
      ensureEnvironment({
        root,
        scope: 'phi',
        kind: 'base',
        spec,
        lockText: LOCK_TEXT,
        sourcePackageInstaller: () => {
          throw new Error('replacement install failed')
        }
      }),
      /replacement install failed/
    )

    assert.equal(existsSync(prefix), false)
    const envId = envIdFor(spec)
    assert.equal(readEnvironmentIndex(realpathSync(root)).environments[envId]?.status, 'failed')
  })
})

function envIdFor(spec: EnvironmentSpec): string {
  return computeEnvId({
    scope: 'phi',
    name: spec.name,
    platform: currentPlatform(),
    lockText: LOCK_TEXT,
    sourcePackages: spec.sourcePackages
  })
}

function resultPrefix(root: string, spec: EnvironmentSpec): string {
  return join(realpathSync(root), 'envs', envIdFor(spec))
}
