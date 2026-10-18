import assert from 'node:assert/strict'
import test from 'node:test'
import { projectToolBoundaryDecision } from '../src/main/agent/engine/phi-extension/lib/project-boundary'

const cwd = process.cwd()
const allowed = (command: string): boolean =>
  projectToolBoundaryDecision(cwd, 'bash', { command }).allowed

test('bash operators and heredoc bodies are not treated as paths', () => {
  assert.equal(allowed("python3 -c 'print(len(arr) // 2)'"), true)
  assert.equal(allowed('echo $(( 10 // 3 )) // note ///'), true)
  assert.equal(
    allowed(`python3 - <<'PY'
arr = [1, 2, 3]
mid = len(arr) // 2
print(mid, "/etc/passwd", "/tmp/not-a-write")
PY
echo done`),
    true
  )
  assert.equal(allowed('cat > notes.txt <<EOF\n/etc/hosts\nEOF'), true)
})

test('real writes outside the project stay blocked around heredocs and operators', () => {
  assert.equal(allowed('echo x > /etc/x'), false)
  assert.equal(allowed('cp data.csv /tmp/y'), false)
  assert.equal(allowed('cd /'), false)
  assert.equal(allowed('cd ~/other'), false)
  assert.equal(allowed('cat > /etc/x <<EOF\nbody\nEOF'), false)
  assert.equal(allowed("python3 - <<'PY'\nx = 1 // 2\nPY\ncp a /tmp/y"), false)
  assert.equal(allowed('echo $(( 4 // 2 )) && cp a /tmp/y'), false)
})
