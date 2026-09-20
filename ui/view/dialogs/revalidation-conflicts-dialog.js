import { html, nothing, unsafeCSS } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { severityBadge } from './shared.js'
import { REPORT_LOGOS, displayName, groupOf } from '../file-display.js'
import { findingTitle, lineRange, lineRangeLabel, shortFindingId } from '../format.js'
import { revalidationDifferences } from '../revalidation-conflicts.js'
import severityCSS from './dialog-severity.css'
import fileIconCSS from '../../styles/file-icon.css'
import conflictsCSS from './dialog-revalidation-conflicts.css'

const FIELD_LABELS = {
  revalidate: 'Outcome',
  revalidateVerdict: 'Explanation',
  revalidateRecommendation: 'Recommendation',
}

class RevalidationConflictsDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(severityCSS), unsafeCSS(fileIconCSS), unsafeCSS(conflictsCSS)]

  static properties = { conflicts: { attribute: false } }

  constructor() {
    super()
    this.conflicts = []
  }

  render() {
    return html`<dialog aria-labelledby="revalidation-conflicts-title" @close=${this._onClose}>
      <header>
        <h3 id="revalidation-conflicts-title">Revalidation conflicts</h3>
        <p class="nwd-intro">Reports disagree about ${this.conflicts.length} finding${this.conflicts.length === 1 ? '' : 's'}. App view is unavailable until the conflicting reports are separated or updated.</p>
      </header>
      <ul class="conflicts-list">${this.conflicts.map(({ finding, copies }) => html`<li class="conflict-card">
        <div class="finding-meta">
          ${severityBadge(finding.severity)}
          ${finding.file ? html`<span class="location">${finding.file}${lineRange(finding.line) ? `:${lineRangeLabel(lineRange(finding.line))}` : ''}</span>` : nothing}
          <code>${shortFindingId(finding.id) ?? finding.id}</code>
        </div>
        <h4>${findingTitle(finding)}</h4>
        <dl>${revalidationDifferences(copies).map(({ field, variants }) => html`
          <dt>${FIELD_LABELS[field] ?? field}</dt>
          ${variants.map(({ value, reports }) => html`<dd class="variant">
            <div class="value">${value || html`<em>Empty</em>`}</div>
            <div class="reports">${reports.map((name) => name ? html`<button type="button" class="report-button"
              aria-label=${`Open ${displayName(name)} at this finding`}
              @click=${() => this._finish({ id: finding.id, reportName: name })}
            >${unsafeHTML(REPORT_LOGOS[groupOf(name)] ?? REPORT_LOGOS.default)}<span>${displayName(name)}</span></button>` : html`<span>Loaded report</span>`)}</div>
          </dd>`)}
        `)}</dl>
      </li>`)}</ul>
      <footer class="nwd-actions"><span class="nwd-spacer"></span><button type="button" @click=${this._onClose}>Close</button></footer>
    </dialog>`
  }
}

customElements.define('revalidation-conflicts-dialog', RevalidationConflictsDialog)

export function openRevalidationConflictsDialog(conflicts) {
  return openAppDialog('revalidation-conflicts-dialog', { conflicts: [...conflicts.values()] })
}
