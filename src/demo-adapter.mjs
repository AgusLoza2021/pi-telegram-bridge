// T04: demo adapter — a local stand-in for the real Pi adapter used ONLY
// by host-only demo mode and the Windows smoke harness.
//
// It mirrors the real extension demo flow (scripts run inside pi):
//  1. host sends the demo prompt carrying a nonce;
//  2. pi "asks" a select question;
//  3. the decision response triggers the nonce-bound notify, which is
//     what completes the demo request in SessionHost.
// No network, no model spend, no real pi process.



export class DemoAdapter {
  constructor({ requestTimeoutMs = 30000 } = {}) {
    this.#nonce = null; // parsed from the /bridge-demo prompt, like the real extension
    this.#uiHandlers = [];
    this.#eventHandlers = [];
    this.#started = false;
  }

  #nonce;
  #uiHandlers;
  #eventHandlers;
  #started;

  async start() {
    this.#started = true;
    // pid: null — the demo adapter owns no process; reporting the host's
    // own pid here would falsely suggest a real Pi child (misleading
    // piPid == hostPid). host-meta.json stores piPid: null in demo mode.
    return { sessionId: 'pi-demo', sessionFile: 'demo-session.jsonl', pid: null };
  }

  onEvent(handler) { this.#eventHandlers.push(handler); }
  onUiRequest(handler) { this.#uiHandlers.push(handler); }

  send(command) {
    // The demo prompt is the only command the demo lifecycle produces.
    // Mirroring the real extension: the /bridge-demo command runs inside
    // pi and comes back as a select question.
    if (command && command.type === 'prompt'
      && typeof command.message === 'string' && command.message.startsWith('/bridge-demo')) {
      // The nonce travels in the command text; the real extension parses
      // it and binds it into the completion notify. Same here.
      const match = /^\/bridge-demo ([0-9a-f]+)$/.exec(command.message);
      if (match) this.#nonce = match[1];
      queueMicrotask(() => {
        if (!this.isRunning()) return;
        for (const handler of this.#uiHandlers) {
          handler({
            id: `ui-demo-${Date.now()}`, method: 'select',
            title: 'Bridge demo', options: ['Option A', 'Option B'],
          });
        }
      });
    }
    return Promise.resolve({ success: true });
  }

  respondUi(id, response) {
    // A select answer triggers the nonce-bound notify, exactly like the
    // real extension does after receiving bridge_decision.
    if (response && typeof response === 'object' && typeof response.value === 'string') {
      const message = JSON.stringify({ nonce: this.#nonce, choice: response.value });
      queueMicrotask(() => {
        for (const handler of this.#uiHandlers) {
          handler({ id: `${id}-notify`, method: 'notify', message });
        }
      });
    }
  }

  isRunning() { return this.#started; }

  async dispose() {
    this.#started = false;
  }
}
