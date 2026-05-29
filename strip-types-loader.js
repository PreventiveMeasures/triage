// Module customization hook that erases TypeScript types using Node's
// built-in `module.stripTypeScriptTypes()` — the same eraser that powers
// Node's unflagged `.ts` execution, exposed here as an explicit loader so
// this package can run its own `.ts` source after it's installed as a
// dependency. Built on Node's bundled eraser, it needs no third-party dep
// (cf. `amaro`, which is just the library Node already bundles for this).
//
// Why this is needed at all — Node DISABLES built-in `.ts` stripping for
// any file under `node_modules` (it throws ERR_UNSUPPORTED_NODE_MODULES_
// TYPE_STRIPPING), which is exactly where this package's `.ts` files live
// once it's a dependency. A registered `load` hook is not bound by that
// rule, so it restores `.ts` execution from inside `node_modules`.
//
// Registered as an entry point — `@preventive/triage/strip-types-loader` —
// so consumers can run the server (or import `@preventive/triage/server`)
// with the hook active:
//   node --import @preventive/triage/strip-types-loader <entry>
//
// `registerHooks` (synchronous, in-thread) is used over the async,
// worker-thread `module.register`: stripping is a pure synchronous string
// transform, so there's no reason to round-trip every load through a
// worker — and the read below is synchronous too.
//
// We must read + strip the source OURSELVES rather than delegate to
// `nextLoad`: under `node_modules`, `nextLoad`'s default format detection
// is what throws ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, before our
// hook ever sees the source. Reading the bytes and short-circuiting with
// an explicit format sidesteps that gate.
//
// `mode: 'strip'` (types elided, no enum/namespace transform) suffices —
// the repo is `erasableSyntaxOnly` (tsconfig.json). Strip mode replaces
// each elided type with equal-width whitespace, so line AND column
// positions survive 1:1 and stack traces stay exact without a source map.

import { isUtf8 } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

// `.ts` / `.mts` -> ESM, `.cts` -> CommonJS. The `kind` group is the
// optional `m`/`c` infix; absent (plain `.ts`) defaults to ESM, which is
// correct for this `"type": "module"` package.
const TS_RE = /\.(?<kind>[cm])?ts$/u

// Defence-in-depth: assert strip mode only ERASED — every output character
// is either unchanged, replaced by whitespace, or replaced by a semicolon
// (swc's ASI guard — swc-project/swc#9331). This enforces at runtime what
// tsconfig's `erasableSyntaxOnly` asserts at type-check time: nothing but
// type syntax was removed, so the bytes Node runs can't silently diverge
// from the bytes we wrote.
//
// The comparison is per-CODE-POINT, not per-byte. swc preserves byte
// offsets by swapping each elided multi-byte character for a *same-width*
// Unicode whitespace char — e.g. an em-dash (U+2014) in a type-level
// comment becomes U+2002 EN SPACE, not ASCII 0x20 — so a raw-byte check
// would false-positive on the many such comments in this codebase. `\s`
// matches those Unicode spaces, and strip preserves code-unit length too,
// so string indices stay aligned.
const WHITESPACE = /\s/u

function assertOnlyErased(url, source, stripped) {
  if (source.length !== stripped.length) {
    throw new Error(`strip-types-loader: ${url} changed length ${source.length} -> ${stripped.length}; not a pure type erasure`)
  }
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]
    if (ch === source[i] || ch === ';' || WHITESPACE.test(ch)) continue
    throw new Error(`strip-types-loader: ${url} char ${i} changed ${JSON.stringify(source[i])} -> ${JSON.stringify(ch)}; not a pure type erasure`)
  }
}

registerHooks({
  load(url, context, nextLoad) {
    const match = TS_RE.exec(new URL(url).pathname)
    if (match) {
      const bytes = readFileSync(fileURLToPath(url))
      // Assert the source is valid UTF-8 before decoding: a mis-encoded
      // file (latin-1, UTF-16, a stray binary) would otherwise decode with
      // U+FFFD replacement chars and we'd strip / execute silent garbage.
      if (!isUtf8(bytes)) {
        throw new Error(`strip-types-loader: ${url} is not valid UTF-8`)
      }
      const raw = bytes.toString('utf8')
      const stripped = stripTypeScriptTypes(raw, { mode: 'strip' })
      assertOnlyErased(url, raw, stripped)
      return {
        format: match.groups.kind === 'c' ? 'commonjs' : 'module',
        source: stripped,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})
