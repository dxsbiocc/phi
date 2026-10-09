import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Hand-authored execution contract; no nf-core source or external content checkout is needed. */
export function writeGffreadFixture(root: string): string {
  const component = join(root, 'modules', 'nf-core', 'gffread')
  const files = {
    'main.nf': `process GFFREAD {
    container 'https://example.org/gffread.sif'
    script:
    'true'
}\n`,
    'environment.yml': 'name: fixture\nchannels: [conda-forge]\ndependencies: [gffread=0.12.7]\n',
    'meta.yml':
      'name: gffread\ndescription: Annotation conversion fixture\nkeywords: [conversion]\ntools:\n  - gffread:\n      description: Fixture tool\n      licence: [MIT]\n',
    'wrapper/main.nf':
      "nextflow.enable.dsl = 2\ninclude { GFFREAD } from '../main.nf'\nworkflow { GFFREAD(Channel.empty()) }\n",
    'wrapper/nextflow.config':
      'profiles { docker { docker.enabled = true }; singularity { singularity.enabled = true }; conda { conda.enabled = true } }\n',
    'wrapper/params.json': '{"gff":"tests/data/genome.gff3","outdir":"results"}\n',
    'wrapper/wrapper.yaml': `id: nf-core/modules/gffread
name: gffread
summary: Convert an annotation with the test execution fixture.
params:
  gff:
    kind: input
    type: file
    required: true
  outdir:
    kind: output
    type: path
    required: true
outputs:
  annotation:
    type: directory
    path: '\${outdir}/gffread'
    primary: true
`,
    'wrapper/dag.mmd':
      'flowchart TB\n    v0["channel.fromPath"]\n    v1(["GFFREAD"])\n    v0 --> v1\n',
    'tests/data/genome.gff3': '##gff-version 3\nchr1\ttest\tgene\t1\t4\t.\t+\t.\tID=gene1\n'
  }
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(component, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  return component
}
