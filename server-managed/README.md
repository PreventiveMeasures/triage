# DeepView managed-mode server

The **trusted-server** counterpart to the end-to-end-encrypted relay in
[`../server-e2e/`](../server-e2e/). Where the e2e relay only ever sees
opaque ciphertext it can't read, forge, or re-attribute, a managed server
is the authority: users **log in** (GitHub), the server **decides what each
user can see**, stores triage / bundles / reports in a form it can read,
and records every change in a hash-chained **attribution log**.

> **Status: design + scaffold.** The full protocol spec is
> [`MANAGED.md`](./MANAGED.md). The compile-checked type / wire / schema
> skeletons in this directory (`types.ts`, `wire.ts`, `visibility.ts`,
> `schema-sql.ts`) are **not wired into a running server yet** — they pin
> down the shapes so the implementation has one reviewed starting point.

Both servers ship side by side, selected by `SYNC_MODE` and advertised at
`GET /api/sync/info` so the client can adapt its UI:

| | `server-e2e/` (`SYNC_MODE=e2e`) | `server-managed/` (`SYNC_MODE=managed`) |
| --- | --- | --- |
| Trust | untrusted (zero-knowledge) | trusted |
| Identity | per-workspace seed | logged-in GitHub user |
| Visibility | anyone with the tag | server-decided (hybrid GitHub + grants, or explicit ACL) |
| Attribution | client Ed25519 signatures | server-stamped, hash-chained log |

Code shared between the two servers will be extracted to `server-common/`
as the implementation lands; there is nothing to share at the scaffold
stage. See [`MANAGED.md`](./MANAGED.md) for the threat model, visibility
precedence, wire protocol, storage schema, and the implementation plan.
