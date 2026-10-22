// Cursor catalog wire constants, kept out of omp-internals.ts because that file
// loads pi-catalog JSON that Node cannot import without attributes, and the
// scoped H2 gateway is loaded by Node-run tests.

export { CURSOR_DEFAULT_BASE_URL, CURSOR_RUN_PATH } from '@oh-my-pi/pi-catalog/wire/cursor'
