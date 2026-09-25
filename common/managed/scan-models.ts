import { defaultScanModels } from '../default-scan-models.ts'

// Use the same starting catalogue as the UI until managed scan discovery is wired.
const catalogue = defaultScanModels()
export const MANAGED_SCAN_MODELS = Object.freeze(catalogue.models)
export const DEFAULT_MANAGED_SCAN_MODEL = catalogue.defaultModel
