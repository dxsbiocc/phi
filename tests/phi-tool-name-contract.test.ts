import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLibraryCustomTools,
  LIBRARY_TOOL_NAMES
} from '../src/main/agent/library/library-tools'
import {
  buildNotebookCustomTools,
  NOTEBOOK_TOOL_NAMES
} from '../src/main/agent/notebook/notebook-tools'

test('Phi library and notebook tools use provider-compatible underscore names', () => {
  assert.deepEqual(LIBRARY_TOOL_NAMES, [
    'lib_save',
    'lib_update',
    'lib_remove',
    'lib_list',
    'lib_find',
    'lib_audit'
  ])
  assert.deepEqual(NOTEBOOK_TOOL_NAMES, [
    'notebook_list',
    'notebook_read',
    'notebook_insert_cell',
    'notebook_update_cell',
    'notebook_delete_cell',
    'notebook_run_cell',
    'notebook_save'
  ])
  assert.deepEqual(
    buildLibraryCustomTools().map((tool) => tool.name),
    [...LIBRARY_TOOL_NAMES]
  )
  assert.deepEqual(
    buildNotebookCustomTools(async () => ({})).map((tool) => tool.name),
    [...NOTEBOOK_TOOL_NAMES]
  )
  const names = [...LIBRARY_TOOL_NAMES, ...NOTEBOOK_TOOL_NAMES]
  assert.equal(new Set(names).size, names.length)
  for (const name of names) {
    assert.match(name, /^[A-Za-z][A-Za-z0-9_-]*$/)
  }
})
