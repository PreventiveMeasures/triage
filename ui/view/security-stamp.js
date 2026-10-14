// What the security lens stamps across: links files' duplicates, and each App
// finding's `revalidateInputs` — in the stamped rows, and in the rows the
// finding index or managed workspace returns, including App rows that cite a
// stamped finding from a report that is not loaded. Same rule as the managed
// server's permission filter (common/security-links.js).
import { duplicatesOf, reportRowsCitingFindingIds, reportRowsForFindingIds } from '#client/index.js'
import { revalidationLinks, securityLinks } from '../../common/security-links.js'

export function securityStampOptions(groups, knownRows = reportRowsForFindingIds) {
  const links = securityLinks(revalidationLinks(groups.flat()))
  return {
    linkedIds: (id) => [...duplicatesOf(id), ...links.linkedIds(id)],
    knownRows: (ids) => {
      const rows = [...knownRows(ids), ...reportRowsCitingFindingIds(ids)]
      for (const row of rows) for (const link of revalidationLinks(row.members)) links.add(link)
      return rows
    },
  }
}
