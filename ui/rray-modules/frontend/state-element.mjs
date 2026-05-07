import { LitElement } from 'lit';
import { autorun } from './state-management.mjs';

export { LitElement, html, css, render } from 'lit';
export { repeat } from 'lit/directives/repeat.js';
export { map } from 'lit/directives/map.js';

export class StateElement extends LitElement {
  _disposers = [];
  observes = null;

  connectedCallback() {
    super.connectedCallback();
    this.bindState();
  }

  bindState() {
    if (this.observes) {
      // Manual observe
      this._disposers.push(
        autorun(first => {
          this.observes();
          if (!first) this.requestUpdate();
        })
      );
      return;
    }
    // Automatic observe
    if (!this._render) {
      this._render = this.render;
      this.render = () => {
        let result;
        const dispose = autorun(first => {
          if (!first) {
            dispose();
            if (this._dispose === dispose) this._dispose = null;
            this.updateComplete.then(() => this.requestUpdate());
            return;
          }
          result = this._render();
        });
        this._dispose = dispose;
        return result;
      };
    }
    this._disposers.push(() => this._dispose && this._dispose());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    while (this._disposers.length > 0) {
      this._disposers.pop()();
    }
  }
}
