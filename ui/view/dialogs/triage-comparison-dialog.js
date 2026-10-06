import { html, nothing, unsafeCSS } from 'lit'
import { openAppDialog } from './app-dialog.js'
import { ConfirmationDialog } from './confirmation-dialog.js'
import comparisonCSS from './dialog-triage-comparison.css'

const labels = { triage: 'Triage state', color: 'Color', fix: 'Fix', flagged: 'Flag', comment: 'Comments', ignoredReports: 'Per-report ignores' }
const kinds = { 'managed-only': 'Only managed', 'local-only': 'Only local', mismatch: 'Different' }
const buckets = { inprogress: 'In progress', fixed: 'Fixed', invalid: 'Invalid', deleted: 'Deleted' }

function valueTemplate(property, value) {
  if (value === undefined || Array.isArray(value) && value.length === 0) return html`<em class="unset">Not set</em>`
  if (property === 'comment') return value.map(item => html`<div class=${`comment${item.different ? ' changed' : ''}`}>${item.text}</div>`)
  if (property === 'ignoredReports') return html`${value.join('\n')}`
  if (property === 'flagged') return value ? 'Flagged' : 'Not flagged'
  if (property === 'triage') return buckets[value] ?? value
  return value
}

class TriageComparisonDialog extends ConfirmationDialog {
  static styles = [...ConfirmationDialog.styles, unsafeCSS(comparisonCSS)]
  static properties = { comparison: { attribute: false } }

  constructor() {
    super()
    this.comparison = { matched: 0, localFindings: 0, findings: [], skipped: [] }
  }

  firstUpdated() {
    if (this.signal?.aborted) { this._onCancel(); return }
    this.signal?.addEventListener('abort', this._onCancel, { once: true })
    super.firstUpdated()
  }

  disconnectedCallback() {
    this.signal?.removeEventListener('abort', this._onCancel)
    super.disconnectedCallback()
  }

  render() {
    const { matched, localFindings, findings, skipped } = this.comparison
    const counts = { 'managed-only': 0, 'local-only': 0, mismatch: 0 }
    for (const finding of findings) for (const diff of finding.differences) counts[diff.kind]++
    return html`<dialog aria-labelledby="compare-triage-title" @close=${this._onClose}>
      <header><h3 id="compare-triage-title">Compare triage</h3>
        <p class="lwd-body">${matched} shared ${matched === 1 ? 'finding' : 'findings'} compared · ${findings.length} with differences</p>
        <p class="lwd-note">Local reports and managed reports are matched by finding ID. This comparison does not change either side.
          Comments are compared by text; per-report ignores only exist locally.</p>
        ${findings.length > 0 ? html`<div class="difference-counts">Field differences: ${Object.entries(kinds).map(([kind, label]) => html`<span class=${kind}>${label}: ${counts[kind]}</span>`)}</div>` : nothing}
      </header>
      <div class="comparison-results">
        ${skipped.length > 0 ? html`<details class="skipped"><summary>${skipped.length} local ${skipped.length === 1 ? 'report could' : 'reports could'} not be read; comparison is incomplete.</summary>
          <ul>${skipped.map(item => html`<li>${item.name}: ${item.reason}</li>`)}</ul></details>` : nothing}
        ${findings.map(({ id, finding, differences }) => html`<section class="finding">
          <h4>${finding.title || finding.description?.split('\n')[0] || id}</h4>
          ${finding.file ? html`<p class="location">${finding.file}${finding.line ? `:${finding.line}` : ''}</p>` : nothing}
          <p class="finding-id"><code>${id}</code> · ${finding.reports.join(', ')}</p>
          <div class="table-scroll"><table><thead><tr><th scope="col">Field</th><th scope="col">Local</th><th scope="col">Managed</th></tr></thead>
            <tbody>${differences.map(diff => html`<tr class=${diff.kind}>
              <th scope="row">${labels[diff.property]}<span class="difference-kind">${kinds[diff.kind]}</span></th>
              <td class=${diff.kind === 'managed-only' ? '' : 'highlight'}>${valueTemplate(diff.property, diff.local)}</td>
              <td class=${diff.kind === 'local-only' ? '' : 'highlight'}>${valueTemplate(diff.property, diff.managed)}</td>
            </tr>`)}</tbody></table></div>
        </section>`)}
        ${findings.length === 0 ? html`<p class="empty">${matched > 0 ? 'No triage differences in the shared findings.'
          : localFindings === 0 ? 'No findings were found in the readable local reports.' : 'No findings are present in both local and managed reports.'}</p>` : nothing}
      </div>
      <footer class="nwd-actions"><span class="nwd-spacer"></span><button type="button" data-role="cancel" @click=${this._onCancel}>Close</button></footer>
    </dialog>`
  }
}

customElements.define('triage-comparison-dialog', TriageComparisonDialog)
export const openTriageComparisonDialog = props => openAppDialog('triage-comparison-dialog', props)
