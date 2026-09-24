import { defaultEffort } from '../view/scan-models.js'

export const REGIME_MODES = ['security', 'generic', 'correctness']
export const regimeKey = regime => JSON.stringify([regime.mode, regime.model, regime.effort, regime.isolate])

export function normalizeRegimes(regimes, catalogue) {
  const fallback = catalogue.models.find(model => model.id === catalogue.defaultModel) ?? catalogue.models[0]
  if (!fallback) return []
  return (regimes.length > 0 ? regimes : [{ mode: 'generic', isolate: false }]).map(regime => {
    const model = catalogue.models.find(candidate => candidate.id === regime.model) ?? fallback
    return { ...regime, mode: REGIME_MODES.includes(regime.mode) ? regime.mode : 'generic', model: model.id,
      effort: model.efforts.includes(regime.effort) ? regime.effort : defaultEffort(model), isolate: !!regime.isolate }
  })
}

export function duplicateRegimes(regimes) {
  const seen = new Set()
  return regimes.map(regime => {
    const key = regimeKey(regime)
    const duplicate = seen.has(key)
    seen.add(key)
    return duplicate
  })
}
