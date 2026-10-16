# Pre-native-wire-projection baseline

This fixture is the exact `rpc-native-stream-adapter.ts` module and its two
relative local dependencies from commit
`a9b3fb2f0b57eb0f4769b0447a68096334453cdf`, the parent of `77ecfd10`, which
introduced native-wire DTO projection.

The frozen files preserve the negative control used by
`tests/engine-rpc-native-wire-cli.test.ts` without relying on an ignored
developer-only worktree copy or on Git history being available at test time.

SHA-256:

- `rpc-native-stream-adapter.ts`: `3e0c1c14c9aabf101bf1ce572296f2ee127fcb3c2ddcc80f6be9d43d73fe863b`
- `rpc-native-sse.ts`: `6734016457279479fcf632df9c3cb6ba6af4a9fcb913cc4cf832e3507f359f8c`
- `rpc-native-repair.ts`: `4a33c708da2e911089abf7f440dd622d92c7532fc1750d4d77c76e501e795008`
