import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Small local plugin for loader, environment ownership, and icon propagation tests. */
export function writeRuntimePluginFixture(root: string): string {
  const dir = join(root, 'visualization-fixture')
  const skillDir = join(dir, 'skills', 'omics-visualization')
  mkdirSync(join(skillDir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(
    join(dir, 'phi-package.yaml'),
    `schemaVersion: 1
id: visualization
type: plugin
version: 1.0.0
title: Runtime fixture
summary: Local fixture for plugin resource discovery.
toolPrefix: viz
components:
  agents: [agents/Visualization.md]
  skills: [skills/omics-visualization]
`
  )
  writeFileSync(
    join(dir, 'agents', 'Visualization.md'),
    `---
name: Visualization
description: Fixture specialist for resource discovery.
environment: phi:r@1
tools: [read, bash]
skills: [omics-visualization]
delegationMode: required-first
fallback:
  afterFailures: 1
  tools: [bash]
  match: [fixture]
delegation: Delegate only the requested fixture task.
---
Use the fixture skill for this task.
`
  )
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: omics-visualization
description: Fixture skill for resource discovery.
phi:
  environment: phi:r@1
  attachTo: [Visualization]
  scripts:
    - name: inspect
      description: Read a fixture input.
      run: [python, ./scripts/inspect.py]
      args:
        type: object
        properties: {}
        additionalProperties: false
      approval: read
---
Read the supplied fixture input.
`
  )
  writeFileSync(join(skillDir, 'scripts', 'inspect.py'), 'print("{}")\n')
  return dir
}
