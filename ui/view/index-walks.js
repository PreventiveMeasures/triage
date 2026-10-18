import { clientModeLabel, ensureBundleFindingsIndexed, ensureLinkedFindingsIndexed } from '#client/index.js'

// The OPFS-wide index walks the sidebar starts (bundle findings, for the
// Packages count and page, and links, for each finding's "Duplicates:"
// row), each of which reads and parses every report on disk. They wait
// for the boot's first view to be restored (view.js continueBoot calls
// releaseIndexWalks): started with it, they would compete with reading
// and parsing the report being opened. Those asked for meanwhile start
// at the release, if the client is still in the mode that asked. Each
// is idempotent — concurrent calls share the same in-flight promise;
// later calls walk listFiles again to pick up any newly-dropped reports.
let released = false
let askedIn = null

export function startIndexWalks() {
  if (!released) { askedIn = clientModeLabel(); return }
  ensureBundleFindingsIndexed().catch(() => {})
  ensureLinkedFindingsIndexed().catch(() => {})
}

export function releaseIndexWalks() {
  if (released) return
  released = true
  const asked = askedIn
  askedIn = null
  if (asked !== null && asked === clientModeLabel()) startIndexWalks()
}
