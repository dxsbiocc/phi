// `--test-force-exit` ends the runner with process.exit(), which drops whatever a pipe has not yet
// taken. Blocking writes leave nothing queued, so a slow reader cannot lose the end of the report.
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true)
