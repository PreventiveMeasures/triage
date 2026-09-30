import { createHash } from 'node:crypto'
import type { ManagedDb } from './db-methods.ts'
import type { ManagedComment } from '../common/managed/comments.ts'
import type { TriageEntryPatch } from '../common/managed/triage.ts'
import { triageWireEntry } from './triage-response.ts'

export interface ImportTriageSnapshot {
  entry: TriageEntryPatch | null
  comments: ManagedComment[]
  version: string
}
export interface ImportTriageStore {
  getImportTriage(ids: readonly string[]): Promise<Record<string, ImportTriageSnapshot>>
  importTriage(entries: [string, TriageEntryPatch | null][], expected: Record<string, string>, actor: { id: string; login: string }, reportId: string, now: number): Promise<boolean>
}

// Raw store methods share one transaction for comparison, triage, and comments.
export function importTriageMethods(store: Pick<ManagedDb, 'getReport' | 'listTriage' | 'listComments' | 'setTriageEntries' | 'createComment'>): ImportTriageStore {
  async function snapshot(ids: readonly string[]) {
    const rows = new Map((await store.listTriage(ids)).map(row => [row.findingId, row]))
    const comments = await store.listComments(ids)
    return Object.fromEntries(ids.map(id => {
      const row = rows.get(id)
      const entry = row ? triageWireEntry(row) : null
      const own = comments.filter(comment => comment.findingId === id)
      const version = createHash('sha256').update(JSON.stringify([entry, row?.updatedAt, own])).digest('hex')
      return [id, { entry, comments: own, version }]
    }))
  }
  return {
    getImportTriage: snapshot,
    async importTriage(entries, expected, actor, reportId, now) {
      // A report deleted after the HTTP membership check must not leave newly
      // imported annotations behind. Check existence in the write transaction.
      if (!reportId || !(await store.getReport(reportId))) return false
      const current = await snapshot(entries.map(([id]) => id))
      if (entries.some(([id]) => current[id]!.version !== expected[id])) return false
      const changes: [string, TriageEntryPatch | null][] = []
      for (const [id, value] of entries) {
        const { comment, ...entry } = value ?? {}
        changes.push([id, Object.keys(entry).length > 0 ? entry : null])
        if (comment && !current[id]!.comments.some(existing => existing.body === comment)) {
          await store.createComment({ findingId: id, body: comment, authorId: null, authorLogin: null,
            actor, createdAt: null, updatedAt: null, reportId }, now)
        }
      }
      await store.setTriageEntries(changes, actor.id, actor.login, now, reportId)
      return true
    },
  }
}
