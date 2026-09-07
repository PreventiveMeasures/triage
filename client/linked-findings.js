// The "links" file — a small JSON document that says which findings
// are the SAME finding, reported twice:
//
//   [[{"id":"a"},{"id":"b"}], [{"id":"c"},{"id":"d"},{"id":"e"}]]
//
// One inner array per link. Every finding named in it is a duplicate
// of every other one in that array, and the file says nothing else:
// no severity, no title, no file, no prose. That is the whole format.
//
// It is NOT a report, and this module deliberately sits outside
// `report/` because of it. A report carries findings; a links file
// carries only ids of findings that must already live in reports the
// reader holds. So it never reaches `ingestReport` / `state.reports`,
// it has its own view (`ui/view/render-links.js`) that points at the
// findings rather than showing them, and its one effect on the
// findings surfaces is the "Duplicates:" row a linked finding grows
// at the bottom of its card.
//
// Pure — no storage, no DOM, no app state. `linked-findings-index.js`
// beside this file is the OPFS-wide store built on top; everything
// here is text in, data out, so the recognition rules are testable on
// their own.

import { isLinkableFindingId } from './finding-link.js'

// The `source` marker a links file is filed under — the same slot a
// report's producer ('deepsec', 'piolium', …) occupies in the counts
// cache, so `getKind(name)` answers "what kind of file is this" for
// links and reports alike and the sidebar can bucket both from one
// lookup. No report format can collide with it: this value comes from
// here, never from a document's own content.
export const LINKS_KIND = 'links'

// Is this one entry of an inner array — `{"id": "…"}` — as the format
// spells it? Extra fields are allowed and ignored: an exporter that
// writes the title or the report alongside the id is writing a
// superset of this format, not a different one.
function entryId(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const { id } = entry
  return typeof id === 'string' && id.length > 0 ? id : null
}

// Recognise `content` as a links file and normalise it.
//
// Returns `{ groups, skipped }` — `groups` is one `string[]` of finding
// ids per link, and `skipped` counts ids the app could never follow (a
// session-local numeric id, a control character, something absurdly
// long — `isLinkableFindingId` draws the same line the per-finding Link
// button draws). Returns null when the text isn't this format at all.
//
// Recognition is on SHAPE, and it is strict, because this parser runs
// against every dropped file before the report readers get their turn:
// a top-level array, holding only arrays, holding only objects with a
// string `id`. Nothing else this app reads is a bare JSON array, so
// nothing else can be mistaken for one — and an empty top-level array
// is refused rather than claimed, since `[]` is every empty JSON list
// in the world, not distinctively a links file.
//
// Normalisation drops what carries no information: ids repeated inside
// one link, ids that can't be linked, and then any link left naming
// fewer than two findings — a "link" to a single finding links nothing.
// A file whose every link normalises away is still a links file; it
// just has no links, which its view says plainly.
export function parseLinkedFindings(content) {
  let data
  try { data = JSON.parse(content) } catch { return null }
  if (!Array.isArray(data) || data.length === 0) return null
  const groups = []
  let skipped = 0
  for (const raw of data) {
    if (!Array.isArray(raw)) return null
    const ids = new Set()
    for (const entry of raw) {
      const id = entryId(entry)
      if (id === null) return null
      if (isLinkableFindingId(id)) ids.add(id)
      else skipped++
    }
    if (ids.size > 1) groups.push([...ids])
  }
  return { groups, skipped }
}

// How many findings the links in `groups` name, counted once each — a
// finding named by two links is one linked finding. What the sidebar
// badge and the view's header report alongside the link count.
export function countLinkedIds(groups) {
  const ids = new Set()
  for (const group of groups) for (const id of group) ids.add(id)
  return ids.size
}

// Fold links into `index` (a `Map<id, Set<id>>`): every id in a link
// gains every OTHER id in it as a duplicate. Called once per links
// file, so an id linked by two files ends up with the union of what
// both said about it.
//
// Union, NOT transitive closure. If one file links a↔b and another
// links b↔c, then b has two duplicates and a has one — a and c were
// never said to be the same finding, and inferring it would put a
// claim in the reader's card that no file they dropped ever made.
export function collectDuplicates(groups, index) {
  for (const group of groups) {
    for (const id of group) {
      let set = index.get(id)
      if (!set) index.set(id, set = new Set())
      for (const other of group) if (other !== id) set.add(other)
    }
  }
  return index
}
