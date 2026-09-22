# DeepView managed-mode server

The **trusted-server** counterpart to the end-to-end-encrypted relay in
[`../server-e2e/`](../server-e2e/). Where the e2e relay only ever sees opaque
ciphertext it can't read, forge, or re-attribute, a managed server is the
authority: users **log in** (GitHub), the server **decides what each user can
see** — down to individual findings — stores triage / bundles / reports in a
form it can read, and attributes every triage change to the account that made
it.

```sh
node --run server-managed      # http://127.0.0.1:8765
```

A separate process from `node --run server`, with its own SQLite file and no
sync plane. Requires **Node ≥ 24** (built-in `node:sqlite` and native `.ts`
execution — no flags) and a GitHub App for login; see
[`MANAGED.md`](./MANAGED.md) for the required environment.

| | `server-e2e/` | `server-managed/` |
| --- | --- | --- |
| Trust | untrusted (zero-knowledge) | trusted |
| Identity | per-workspace seed | logged-in GitHub user |
| Visibility | anyone with the tag | server-decided: role ladder + team membership + per-finding filtering |
| Attribution | client Ed25519 signatures | server-stamped, with a per-finding trail |

Read [`MANAGED.md`](./MANAGED.md) for the trust model, the authorization
rules, the storage schema, the HTTP surface, the threat model, and the
roadmap. Code shared by both servers lives in
[`../server-common/`](../server-common/) (currently the same-origin gate);
types shared by the managed server and its client live in
[`../common/managed/`](../common/managed/).
