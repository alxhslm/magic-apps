import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { DOM_DRIVE_PREAMBLE } from '../src/dom.js';

describe('DOM driving preamble contracts', () => {
  it('defines resolveOrdered, waitUntil, and clickAndConfirm', () => {
    expect(DOM_DRIVE_PREAMBLE).toContain('resolveOrdered');
    expect(DOM_DRIVE_PREAMBLE).toContain('waitUntil');
    expect(DOM_DRIVE_PREAMBLE).toContain('clickAndConfirm');
  });

  it('rejects non-array arguments to resolveOrdered', () => {
    expect(DOM_DRIVE_PREAMBLE).toContain('!Array.isArray(selectors)');
  });

  it('tracks mutations using MutationObserver rather than fixed attempt counters', () => {
    expect(DOM_DRIVE_PREAMBLE).toContain('new MutationObserver');
    expect(DOM_DRIVE_PREAMBLE).not.toMatch(/attempts\s*<=\s*0/);
    expect(DOM_DRIVE_PREAMBLE).not.toMatch(/check\(\s*25\s*\)/);
  });
});

describe('DOM driving preamble execution', () => {
  function createDomContext() {
    const listeners: Array<() => void> = [];
    class MockMutationObserver {
      constructor(private cb: () => void) {}
      observe() {
        listeners.push(this.cb);
      }
      disconnect() {
        const idx = listeners.indexOf(this.cb);
        if (idx !== -1) listeners.splice(idx, 1);
      }
    }

    const elements = new Map<string, any>();

    const doc = {
      body: {},
      querySelector: (sel: string) => elements.get(sel) || null,
    };

    const win: any = {
      document: doc,
      Date,
      setTimeout,
      clearTimeout,
      Promise,
      Array,
      TypeError,
      MutationObserver: MockMutationObserver,
      MouseEvent: class {
        constructor(public type: string) {}
      },
    };
    win.window = win;

    const ctx = vm.createContext(win);

    return {
      ctx,
      elements,
      triggerMutation: () => {
        listeners.forEach((l) => l());
      },
    };
  }

  it('resolveOrdered evaluates selectors in array order', async () => {
    const { ctx, elements } = createDomContext();
    const btnA = { id: 'btnA' };
    const btnB = { id: 'btnB' };
    elements.set('#first', btnA);
    elements.set('#second', btnB);

    const script = `
      ${DOM_DRIVE_PREAMBLE}
      resolveOrdered(['#second', '#first']);
    `;
    const result = vm.runInContext(script, ctx);
    expect(result).toBe(btnB);
  });

  it('resolveOrdered rejects comma-joined strings', async () => {
    const { ctx } = createDomContext();
    const script = `
      ${DOM_DRIVE_PREAMBLE}
      try {
        resolveOrdered('#second, #first');
        'did-not-throw';
      } catch (err) {
        err.message;
      }
    `;
    const result = vm.runInContext(script, ctx);
    expect(result).toContain('resolveOrdered requires an array of selector strings');
  });

  it('waitUntil resolves when predicate matches and mutations settle', async () => {
    const { ctx, elements } = createDomContext();
    const target = { textContent: 'ready' };

    const script = `
      ${DOM_DRIVE_PREAMBLE}
      waitUntil(() => document.querySelector('#target')?.textContent === 'ready', {
        quietMs: 50,
        pollIntervalMs: 10,
        timeoutMs: 1000,
      });
    `;

    const promise = vm.runInContext(script, ctx);

    // Predicate not yet satisfied
    elements.set('#target', { textContent: 'loading' });
    await new Promise((r) => setTimeout(r, 20));

    // Predicate satisfied
    elements.set('#target', target);
    const outcome = await promise;
    expect(outcome).toBe(true);
  });

  it('clickAndConfirm dispatches mouse events and clicks', async () => {
    const { ctx, elements } = createDomContext();
    const eventsDispatched: string[] = [];
    let clicked = false;

    const btn = {
      dispatchEvent: (e: any) => eventsDispatched.push(e.type),
      click: () => {
        clicked = true;
      },
    };
    elements.set('#submit', btn);

    const script = `
      ${DOM_DRIVE_PREAMBLE}
      clickAndConfirm('#submit', () => true, { quietMs: 0, timeoutMs: 500 });
    `;

    const outcome = await vm.runInContext(script, ctx);
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe('settled');
    expect(outcome.selector).toBe('#submit');
    expect(eventsDispatched).toEqual(['mousedown', 'mouseup']);
    expect(clicked).toBe(true);
  });

  it('clickAndConfirm returns no_element when selector does not match', async () => {
    const { ctx } = createDomContext();

    const script = `
      ${DOM_DRIVE_PREAMBLE}
      clickAndConfirm(['#missing1', '#missing2'], () => true, { timeoutMs: 100 });
    `;

    const outcome = await vm.runInContext(script, ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('no_element');
    expect(outcome.selector).toBeNull();
  });

  it('clickAndConfirm returns predicate_timeout when confirmation condition fails', async () => {
    const { ctx, elements } = createDomContext();
    elements.set('#action', {
      dispatchEvent: () => {},
      click: () => {},
    });

    const script = `
      ${DOM_DRIVE_PREAMBLE}
      clickAndConfirm('#action', () => false, { timeoutMs: 100, pollIntervalMs: 20 });
    `;

    const outcome = await vm.runInContext(script, ctx);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('predicate_timeout');
    expect(outcome.selector).toBe('#action');
  });

  it('runs again in a context it has already been evaluated in', async () => {
    // One action drives the page several times, and every executeJavaScript call lands in
    // the same context, so the preamble is evaluated once per call rather than once per page.
    const { ctx } = createDomContext();

    const first = await vm.runInContext(`${DOM_DRIVE_PREAMBLE} resolveOrdered(['#missing']);`, ctx);
    const second = await vm.runInContext(
      `${DOM_DRIVE_PREAMBLE} resolveOrdered(['#missing']);`,
      ctx,
    );

    expect(first).toBeNull();
    expect(second).toBeNull();
  });
});
