# forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tribunshitpost/forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tribunshitpost/forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node process: git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4, and an MCP endpoint, all served from its own in-memory store with no UI, no outside service, and no git binary. Pure Node standard library; deterministic by construction, so two runs on the same requests leave the same state.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The process binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL/register`, serves until the env answers `{"done": true}` on `$MAKEFUN_ENV_URL/done`, then exits 0.

## Layout

- `main.ts` — entry/env lifecycle: bind, register, wait for done.
- `app.ts` — the HTTP server and auth: bearer token on every surface except `/healthz`.
- `git.ts` — git object model, pkt-line framing, packfile read/write.
- `git-http.ts` — smart HTTP: advertisements, v2 ls-refs/fetch, v0 fetch, receive-pack.
- `store.ts` — repositories, objects, refs, issues, pull requests, trees, diffs and squash merges.
- `rest.ts` — REST v3: repos, branches, commits, contents, labels, issues, pull requests.
- `graphql.ts` — GraphQL v4: the documents gh and github-mcp-server send.
- `mcp.ts` — MCP over Streamable HTTP (revision 2026-07-28, plus the legacy initialize handshake).

---

<sub>Entered on [make.fun](https://make.fun/?ref=24pn59hn&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
