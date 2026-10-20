// A finding's `package` and `repo`: the same few across a team's many
// findings. A team's reports are sent with each once, in the response's
// `values`, and each finding's as its index there
// (server-managed/team-reports.ts), put back as they are read
// (client/managed/session.js).
const FIELDS = ['package', 'repo']

const entriesKey = data => Array.isArray(data?.findings) ? 'findings' : Array.isArray(data?.groups) ? 'groups' : null

// `values`, and `index(data)`: a report's data with its findings' values as
// their index in it, one value at one index across every report it is given.
export function findingValueIndex() {
  const indexes = new Map(), values = []
  const indexOf = value => {
    const key = JSON.stringify(value)
    if (!indexes.has(key)) indexes.set(key, values.push(value) - 1)
    return indexes.get(key)
  }
  const indexed = finding => {
    if (!finding || typeof finding !== 'object' || !FIELDS.some(field => finding[field] != null)) return finding
    const copy = { ...finding }
    for (const field of FIELDS) if (finding[field] != null) copy[field] = indexOf(finding[field])
    return copy
  }
  return {
    values,
    index(data) {
      const key = entriesKey(data)
      return key ? { ...data, [key]: data[key].map(entry => Array.isArray(entry) ? entry.map(indexed) : indexed(entry)) } : data
    },
  }
}

// A report's data, as read, its findings' values put in place of their index
// in a response's `values`; one sent without any as it is.
export function expandFindingValues(data, values) {
  const key = entriesKey(data)
  if (!key || !Array.isArray(values)) return data
  for (const finding of data[key].flat()) {
    if (!finding || typeof finding !== 'object') continue
    for (const field of FIELDS) if (Number.isInteger(finding[field])) finding[field] = values[finding[field]]
  }
  return data
}
