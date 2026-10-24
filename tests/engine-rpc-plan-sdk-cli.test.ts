import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBootstrapFixture } from './engine-contract/bootstrap-stdio-fixture'

test(
  'pinned SDK signs session draft bytes before host tool execution',
  { timeout: 30000 },
  async (t) => {
    const fixture = await createBootstrapFixture({ missingEntry: true })
    t.after(() => fixture.close())
    const auditPath = join(fixture.root, 'plan-audit.jsonl')
    const draftModule = fileURLToPath(
      new URL('../src/main/agent/engine/phi-extension/lib/rpc-plan-draft.ts', import.meta.url)
    )
    const executionModule = fileURLToPath(
      new URL(
        '../src/main/agent/engine/phi-extension/lib/rpc-execution-protocol.ts',
        import.meta.url
      )
    )
    writeFileSync(
      join(fixture.root, 'missing-entry.ts'),
      `import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindRpcMarkdownPlanProposal } from ${JSON.stringify(draftModule)};
import { executionInput } from ${JSON.stringify(executionModule)};
const audit = ${JSON.stringify(auditPath)};
const schema = {type:'object', properties:{title:{type:'string'},content:{type:'string'},planFilePath:{type:'string'}}};
export default (pi) => {
  pi.registerTool({name:'propose_plan_markdown',label:'Propose plan',description:'Fixture review',parameters:schema,
    async execute(_id, input) { appendFileSync(audit, JSON.stringify({stage:'host',input})+'\\n'); return {content:[{type:'text',text:'reviewed'}]}; }});
  pi.on('session_start', async (_event,ctx) => {
    const artifacts = ctx.sessionManager.getArtifactsDir();
    if (!artifacts) throw new Error('Missing real SDK artifacts directory');
    mkdirSync(join(artifacts,'local'),{recursive:true});
    writeFileSync(join(artifacts,'local','PLAN.md'),'# Artifact-derived plan\\n');
    await pi.setActiveTools(['propose_plan_markdown']);
  });
  pi.on('tool_call',(event,ctx) => {
    if (event.toolName !== 'propose_plan_markdown') return;
    return {input:bindRpcMarkdownPlanProposal(ctx.sessionManager,event.input)};
  });
  pi.on('tool_call',(event) => {
    if (event.toolName !== 'propose_plan_markdown') return;
    const input=executionInput({name:'propose_plan_markdown',site:'host',parameters:schema},event.input);
    appendFileSync(audit,JSON.stringify({stage:'signed-projection',input})+'\\n');
    return {input};
  });
};`,
      { mode: 0o600 }
    )
    await fixture.connection.start()
    fixture.provider.enqueue(
      { tool: { name: 'propose_plan_markdown', args: { title: 'Review' } } },
      { text: 'done' }
    )
    assert.equal((await fixture.connection.prompt('Submit this plan.')).status, 'completed')
    const audit = readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { stage: string; input: Record<string, unknown> })
    assert.deepEqual(
      audit.map((item) => item.stage),
      ['signed-projection', 'host']
    )
    for (const item of audit)
      assert.deepEqual(item.input, {
        title: 'Review',
        content: '# Artifact-derived plan\n',
        planFilePath: 'local://PLAN.md'
      })
  }
)
