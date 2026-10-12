// Answers kept for an hour, by what they answer (npm-insights.ts,
// npm-provenance.ts), at most `max` of them, the oldest asked going first;
// one still being asked for is shared, and one that failed, or that `whole`
// says is partial, is dropped once it is answered. `peek` gives one already
// answered, asking for nothing; undefined where none is.
const KEPT_MS = 60 * 60_000

export function kept<T>(max: number, whole: (value: T) => boolean = () => true) {
  const answers = new Map<string, { at: number; value: Promise<T>; answered?: { value: T } }>()
  const get = (key: string, ask: () => Promise<T>): Promise<T> => {
    const now = Date.now()
    const hit = answers.get(key)
    if (hit && now - hit.at < KEPT_MS) return hit.value
    const value = ask()
    const entry: { at: number; value: Promise<T>; answered?: { value: T } } = { at: now, value }
    answers.delete(key)
    answers.set(key, entry)
    while (answers.size > max) answers.delete(answers.keys().next().value!)
    const drop = () => { if (answers.get(key) === entry) answers.delete(key) }
    value.then(answer => { if (whole(answer)) entry.answered = { value: answer }; else drop(); return answer }, drop)
    return value
  }
  const peek = (key: string): T | undefined => {
    const hit = answers.get(key)
    return hit?.answered && Date.now() - hit.at < KEPT_MS ? hit.answered.value : undefined
  }
  return Object.assign(get, { peek })
}
