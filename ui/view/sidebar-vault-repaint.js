import { isWipingInThisTab, onVaultStateChange } from '#client/index.js'

// Repaint on each vault-state change except the one a wipe in this tab fires.
// That change fires before the wipe removes the OPFS report and bundle dirs,
// and the page reloads once the wipe resolves. A repaint started by it would
// only race the removal: `listFiles` would iterate a dir handle that was
// removed underneath it (an unhandled NotFoundError), or recreate the dir
// after the wipe removed it. Other repaints run as before, and their errors
// are not caught here.
export function repaintOnVaultChange(repaint) {
  return onVaultStateChange(() => {
    if (!isWipingInThisTab()) repaint()
  })
}
