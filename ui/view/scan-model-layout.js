import { modelDeveloper } from './scan-models.js'

export function modelSections(models) {
  const groups = Map.groupBy(models, model => modelDeveloper(model.id).key)
  return [...groups].flatMap(([key, entries]) => {
    // Keep normal groups together; let long providers continue across columns
    // with balanced chunks and a heading on each continuation.
    const size = Math.ceil(entries.length / Math.ceil(entries.length / 8))
    const sections = []
    for (let start = 0; start < entries.length; start += size) sections.push({ key, models: entries.slice(start, start + size) })
    return sections
  })
}

export function modelColumns(sections, requested) {
  if (sections.length === 0) return []
  const count = Math.min(sections.length, Math.max(1, requested))
  // Approximate row heights in half-row units, including the provider heading
  // and spacing. Find the shortest maximum column height while retaining the
  // catalogue order. CSS multicol balancing can leave requested columns empty.
  const weights = sections.map(section => section.models.length * 2 + 3)
  let high = weights.reduce((sum, weight) => sum + weight, 0), low = Math.max(...weights)
  while (low < high) {
    const limit = Math.floor((low + high) / 2)
    let height = 0, used = 1
    for (const weight of weights) {
      if (height + weight > limit) { used++; height = 0 }
      height += weight
    }
    if (used > count) low = limit + 1
    else high = limit
  }
  const columns = []
  let column = [], height = 0
  for (const [index, section] of sections.entries()) {
    // Reserve a section for each remaining column even when two short groups
    // would fit together. Every grid track must have actual content.
    if (column.length > 0 && (height + weights[index] > low || sections.length - index === count - columns.length - 1)) {
      columns.push(column)
      column = []
      height = 0
    }
    column.push(section)
    height += weights[index]
  }
  columns.push(column)
  return columns
}
