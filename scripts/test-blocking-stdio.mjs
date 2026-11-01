// `--test-force-exit` also ends each test process with process.exit(), which drops whatever its pipe
// to the runner has not yet taken, and with it that file's last results. Blocking writes leave
// nothing queued. The runner itself does not load `--import`; see test-run-report.mjs for its output.
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true)
