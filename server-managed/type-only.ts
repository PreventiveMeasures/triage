// Compare's changes to TypeScript declaration files in types alone (GET
// /api/bundles/:id/type-only?other=, GET /api/npm/type-only): every file
// that changed between a comparison's two sides, added and removed ones too,
// paired as its viewer pairs them (rename-diff.ts comparedFiles), whose
// change @preventive/compare's compareTrees stamps
// `typeOnly` -- each side there a file named as a declaration file and
// proven to hold types alone but for a runtime, the module loads and
// `export {}` its stripping leaves, that the change leaves as it was, an
// added one's empty or a single bare `export {}` (proveTypeOnly) -- and
// nothing else. Proven in a worker, off the event loop, a comparison at a
// time per process, for at most a minute; told a line each, `{ path, hash,
// otherPath, otherHash }`, a side not there null, which the viewer checks
// name the files it shows. Access is the caller's to check.
import { type ComparedSide, PrettyError, type PrettyRequest } from './pretty-print.ts'
import { comparedFiles } from './rename-diff.ts'
import { workerTurns } from './worker-turns.ts'

// TypeScript files, by extension as the pretty-print cache reads them: none
// other is asked about.
const TYPESCRIPT = new Set(['ts', 'mts', 'cts'])
// Comparisons proven at once per process, and those waiting their turn past
// them, any more refused; the longest one may take, its wait included.
const MAX_ACTIVE_PROOFS = 1
const MAX_WAITING_PROOFS = 16
const PROOF_TIMEOUT_MS = 60_000

type File = PrettyRequest & { text: string }
export interface TypeOnlyLine { path: string | null; hash: string | null; otherPath: string | null; otherHash: string | null }

const workers = workerTurns({ what: 'type-only proof', active: MAX_ACTIVE_PROOFS, waiting: MAX_WAITING_PROOFS, error: PrettyError,
  busy: 'proof-busy', timeout: 'proof-timeout', failed: 'unproven' })

// Which of `pairs` compareTrees stamps types only, by index, in a worker
// settled once it is gone; none where it fails, as no proof should.
function proven(pairs: Array<[File | null, File | null]>, deadline: number): Promise<boolean[]> {
  return workers.run(new URL('./type-only-worker.js', import.meta.url), {
    workerData: { pairs: pairs.map(sides => sides.map(file => file && { path: file.path, text: file.text })) },
    // Node's type stripping, which the proof holds oxc's tree to, warns it is experimental.
    execArgv: ['--disable-warning=ExperimentalWarning'], resourceLimits: { maxOldGenerationSizeMb: 1024 },
  }, (told): boolean[] | null => (Array.isArray(told) && told.length === pairs.length && told.every(one => typeof one === 'boolean') ? told : null), deadline)
}

// The files that changed between a comparison's two sides in types alone,
// as the viewer pairs them, a line each once all are proven, in path order.
export function typeOnlyFiles([base, other]: readonly [ComparedSide, ComparedSide]): AsyncGenerator<TypeOnlyLine> {
  const typescript = ({ files }: ComparedSide) => new Map(files.filter(file => TYPESCRIPT.has(file.extension)).map(file => [file.path, file]))
  const [olds, news] = [typescript(base), typescript(other)]
  const { changed, onlyBase, onlyOther } = comparedFiles([base, other])
  // A side there not a TypeScript file this reads leaves its pair out; one not there is null.
  const pairs = [...changed.map(({ path, basePath = path }) => [olds.get(basePath), news.get(path)]),
    ...onlyBase.map(({ path, basePath = path }) => [olds.get(basePath), null]), ...onlyOther.map(({ path }) => [null, news.get(path)])]
    .filter((sides): sides is [File | null, File | null] => sides.every(file => file !== undefined) && sides.some(file => file !== null) && sides[0]?.hash !== sides[1]?.hash)
    .toSorted(([a, b], [c, d]) => {
      const [x, y] = [(b ?? a)!.path, (d ?? c)!.path]
      return x < y ? -1 : x > y ? 1 : 0
    })
  return (async function* () {
    if (pairs.length === 0) return
    const deadline = Date.now() + PROOF_TIMEOUT_MS
    const stamped = await workers.inTurn(deadline, () => proven(pairs, deadline))
    for (const [i, [from, to]] of pairs.entries()) {
      if (stamped[i]) yield { path: from?.path ?? null, hash: from?.hash ?? null, otherPath: to?.path ?? null, otherHash: to?.hash ?? null }
    }
  })()
}
