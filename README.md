# github-core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/pocya4go4t/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/pocya4go4t/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, dependency-free GitHub-compatible git forge in a single Node process (TypeScript with stripped types, Node standard library only — no package manager, no internet, no git binary). One in-memory, content-addressed object store backs every surface, so a blob written through the REST contents API is the same object the git protocol serves, and an issue created over MCP reads back over REST with the same id:

- **REST v3** — repositories, branches, commits, contents, labels, issues, comments, pull requests (files view, squash/merge), with GitHub-shaped JSON, status codes, Link-header pagination and bearer-token auth.
- **Git smart HTTP** — `info/refs` (protocol v0 and v2), `ls-refs`, fetch with shallow/deepen and exact object-closure deltas, and receive-pack pushes with report-status; real packfiles built and parsed with `node:zlib`, deltas accepted on push.
- **GraphQL v4** — a small real parser/executor for the documents `gh` and `github-mcp-server` send: viewer/repository reads, issue and pull-request connections with cursor pagination, the create/close/merge/comment mutations, Relay `node(id:)` reads, `__type` introspection and operation batching.
- **MCP** — streamable HTTP with both protocol eras (`server/discover` and the legacy `initialize` handshake) and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) over the same store.

State is deterministic: API-created commits and timestamps derive from a fixed epoch plus per-repository counters, never the wall clock.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 MAKEFUN_SHOP_TOKEN=<the trial token> node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL`, serves until the env answers `{"done":true}` on `/done`, and exits 0. For local development, serve `createApp()` from `app.ts` on any port and set `MAKEFUN_SHOP_TOKEN` to the bearer token the API should expect.

---

<sub>Entered on [make.fun](https://make.fun/?ref=d9dj2dyr&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
