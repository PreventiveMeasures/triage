// Whether a stored report may be switched to open on Confirmed (Manage →
// Reports), told of its content alone: where its pass leaves Confirmed rows of
// its own but it is no App view on its own, by the stricter rule App mode
// keeps (common/workspace-app.js confirmedDefaultOffered). A switched report's
// findings count as covered wherever Confirmed would hide them
// (common/finding-filters.js confirmedCoverage), both for the outcome a view
// opens on and for its team's App mode.
//
// Read as a report is uploaded, and kept (managed_report confirmed_offered):
// its bytes never change. One uploaded before the column is read as the
// reports page lists it, a bounded share of them each time, or as its switch
// is asked for.
import { backfillFindingIds, reportEntries } from '@preventive/report'
import { readManagedReport } from '../common/managed/report-content.ts'
import { managedReportConfirmedDefaultOffered } from '../common/managed/team-app.js'
import type { BlobStore } from './blob-store.ts'
import type { ManagedDb } from './db.ts'
import { eachOf } from './queue.ts'

// Of a report's parsed content, its findings' IDs backfilled first as a team's
// are (team-reports.ts), which it changes in place. A report whose rows cannot
// be read this way has no switch to offer.
export async function confirmedDefaultOffered(filename: string, data: unknown): Promise<boolean> {
  try {
    const findings = (reportEntries(data) ?? []).flatMap(entry => Array.isArray(entry) ? entry : [entry])
      .filter((finding): finding is Record<string, unknown> => finding !== null && typeof finding === 'object' && !Array.isArray(finding))
    await backfillFindingIds(findings)
    return managedReportConfirmedDefaultOffered(filename, data)
  } catch (error) {
    console.warn('managed: reading a report for its opening failed:', error)
    return false
  }
}

// Of a stored report, read of its blob: null where its bytes cannot be read
// now, so a later read tries again.
async function readStored(store: BlobStore, report: { id: string; filename: string }): Promise<boolean | null> {
  const bytes = await store.get(report.id).catch(() => null)
  if (!bytes) return null
  const { data } = readManagedReport(bytes.toString('utf8'), report.filename)
  return data == null ? false : confirmedDefaultOffered(report.filename, data)
}

// The same, kept.
export async function readConfirmedOffered(db: ManagedDb, store: BlobStore, report: { id: string; filename: string }): Promise<boolean | null> {
  const offered = await readStored(store, report)
  if (offered !== null) await db.setReportsConfirmedOffered([{ id: report.id, offered }])
  return offered
}

// At most this many bytes of reports not read yet are read for one listing,
// two at a time, and kept in one write; the rest wait for the next.
const LISTING_READ_BYTES = 64 * 1024 * 1024
const LISTING_READS_AT_ONCE = 2

// The listed reports, those not read for their opening yet read, as many as
// fit the bound: the first always, however large.
export async function withConfirmedOffered<T extends { id: string; filename: string; byteSize: number; confirmedOffered: boolean | null }>(
  db: ManagedDb, store: BlobStore, reports: readonly T[]): Promise<T[]> {
  let budget = LISTING_READ_BYTES
  const unread = reports.filter(report => {
    if (report.confirmedOffered !== null || budget <= 0) return false
    budget -= report.byteSize
    return true
  })
  if (unread.length === 0) return [...reports]
  const read = new Map<string, boolean>()
  await eachOf(unread, LISTING_READS_AT_ONCE, async report => {
    const offered = await readStored(store, report).catch((error: unknown) => {
      console.warn('managed: reading a report for its opening failed:', error)
      return null
    })
    if (offered !== null) read.set(report.id, offered)
  })
  if (read.size > 0) await db.setReportsConfirmedOffered([...read].map(([id, offered]) => ({ id, offered })))
  return reports.map(report => read.has(report.id) ? { ...report, confirmedOffered: read.get(report.id)! } : report)
}
