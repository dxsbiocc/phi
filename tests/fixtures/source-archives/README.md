Pinned R source archives used by the environment tests, named by their sha256 (the
`<runtime root>/sources/` cache layout). `tests/helpers/testRuntimeRoot.ts` copies them into
each test runtime root so the tests do not depend on CRAN or GitHub being reachable.

| sha256 prefix | Package           | Source              |
| ------------- | ----------------- | ------------------- |
| `5c035e74`    | praise 1.0.0      | CRAN                |
| `63da38c4`    | testit @ 48a814e3 | GitHub yihui/testit |
| `08ed9080`    | here 1.0.1        | CRAN archive        |
