// The dependency layout uses arbitrary world units. In that view, fit is the
// useful 100% reference for both the readout and the zoom limit.
export function graphZoomMetrics(scale, fitScale, relativeToFit = false) {
  const unit = relativeToFit ? fitScale : 1
  return { min: fitScale, max: unit * 9.99, percent: Math.round(scale / unit * 100) }
}
