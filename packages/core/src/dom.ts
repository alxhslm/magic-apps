/**
 * Shared DOM-driving primitives for Chromium web views.
 *
 * Both Magimail and Magical automate web clients (Gmail and Google Calendar) by driving
 * their semantic DOM elements. Driving happens inside `executeJavaScript`, so core
 * exports these primitives as a preamble string prepended to scripts rather than a
 * module imported into the page.
 */

export type DomClickReason = 'settled' | 'no_element' | 'dispatch_failed' | 'predicate_timeout';

export interface DomClickResult {
  ok: boolean;
  reason: DomClickReason;
  selector: string | null;
  elapsedMs: number;
}

export interface WaitUntilOptions {
  /**
   * How long mutations must be quiet after the predicate first matches before returning,
   * in milliseconds. Defaults to 0 (resolve immediately once predicate is truthy).
   */
  quietMs?: number;
  /**
   * Overall deadline before giving up and returning false, in milliseconds.
   * Defaults to 10,000 ms.
   */
  timeoutMs?: number;
  /**
   * Polling check interval in milliseconds. Defaults to 50 ms.
   */
  pollIntervalMs?: number;
  /**
   * Optional human-readable action label included in diagnostic log messages.
   */
  label?: string;
}

/**
 * JavaScript source string providing `resolveOrdered`, `waitUntil`, `clickAndConfirm` and
 * `findAction`. Prepend this to any script executed via `webContents.executeJavaScript`.
 *
 * Bound with `var` rather than `const` because every `executeJavaScript` call shares one
 * page context, and a lexical binding survives the script that made it. A second script
 * carrying this preamble then fails to parse with "Identifier 'resolveOrdered' has already
 * been declared", and the whole script is dropped before its first statement runs. That is
 * not a rare case: one action routinely drives the page several times — Magical's reveal
 * waits for the grid, routes, then clicks the chip — so the first call would work and
 * every later one would report the page as unreachable. `var` redeclares harmlessly, and
 * the cached `window.__magicDomPrimitives` keeps the second run from rebuilding anything.
 */
export const DOM_DRIVE_PREAMBLE = `
var { resolveOrdered, waitUntil, clickAndConfirm, findAction } = (() => {
  if (window.__magicDomPrimitives) {
    return window.__magicDomPrimitives;
  }

  const domLog = (level, msg) => {
    if (typeof console !== 'undefined' && typeof console[level] === 'function') {
      console[level]('[magic:dom] ' + msg);
    }
  };

  /**
   * Resolves the first selector that matches an element, in array order.
   *
   * Rejects comma-joined strings so the caller cannot accidentally rely on
   * document-order evaluation.
   */
  function resolveOrdered(selectors, root = document) {
    if (!Array.isArray(selectors)) {
      throw new TypeError('resolveOrdered requires an array of selector strings; comma-joined strings evaluate in document order');
    }
    domLog('debug', 'resolveOrdered checking ' + selectors.length + ' selector(s)');
    for (const sel of selectors) {
      if (typeof sel !== 'string') continue;
      const el = root.querySelector(sel);
      if (el) {
        domLog('debug', 'resolveOrdered matched: ' + sel);
        return el;
      }
    }
    domLog('debug', 'resolveOrdered: no selector matched');
    return null;
  }

  /**
   * Waits until a predicate matches and DOM mutations settle for quietMs.
   *
   * Replaces fixed attempt budgets with document mutation observation.
   */
  function waitUntil(predicate, options = {}) {
    const quietMs = typeof options.quietMs === 'number' ? options.quietMs : 0;
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 10000;
    const pollIntervalMs = typeof options.pollIntervalMs === 'number' ? options.pollIntervalMs : 50;
    const label = typeof options.label === 'string' ? options.label + ' ' : '';
    const startTime = Date.now();

    domLog('debug', 'waitUntil ' + label + 'started (timeout=' + timeoutMs + 'ms, quiet=' + quietMs + 'ms)');

    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      let lastMutation = Date.now();
      let matchedResult = null;
      let matchedAt = 0;

      const observer = new MutationObserver(() => {
        lastMutation = Date.now();
      });

      if (document.body) {
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }

      const cleanup = () => {
        observer.disconnect();
      };

      const check = () => {
        const now = Date.now();
        if (now > deadline) {
          cleanup();
          domLog('warn', 'waitUntil ' + label + 'timed out after ' + timeoutMs + 'ms');
          return resolve(false);
        }

        if (matchedResult === null) {
          try {
            const res = predicate();
            if (res) {
              matchedResult = res;
              matchedAt = now;
              domLog('debug', 'waitUntil ' + label + 'predicate matched in ' + (now - startTime) + 'ms' + (quietMs > 0 ? ', awaiting ' + quietMs + 'ms quietness' : ''));
            }
          } catch {
            // Predicate might query nodes that transiently detached
          }
        }

        if (matchedResult !== null) {
          const quietFor = now - lastMutation;
          const matchedFor = now - matchedAt;
          if (quietMs <= 0 || (quietFor >= quietMs && matchedFor >= quietMs)) {
            cleanup();
            domLog('debug', 'waitUntil ' + label + 'settled after ' + (now - startTime) + 'ms');
            return resolve(matchedResult);
          }
        }

        setTimeout(check, pollIntervalMs);
      };

      check();
    });
  }

  /**
   * Clicks an element and waits for a confirmation condition to settle.
   */
  async function clickAndConfirm(element, confirms, options = {}) {
    const label = typeof options.label === 'string' ? options.label + ' ' : '';
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 10000;
    const startTime = Date.now();

    let target = null;
    let matchedSelector = null;

    if (element && element.nodeType === 1) {
      target = element;
      matchedSelector = options.selector || null;
    } else if (typeof element === 'string' || Array.isArray(element)) {
      const selectors = Array.isArray(element) ? element : [element];
      const isVisible = (node) => {
        if (typeof node.checkVisibility === 'function') {
          return node.checkVisibility();
        }
        if (node.offsetParent !== undefined && node.offsetParent === null) {
          return (node.offsetWidth || 0) > 0 || (node.offsetHeight || 0) > 0;
        }
        return true;
      };

      const found = await waitUntil(() => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && isVisible(el)) {
            return { el, sel };
          }
        }
        return null;
      }, { timeoutMs: Math.min(timeoutMs, 5000), quietMs: 0 });

      if (found && found.el) {
        target = found.el;
        matchedSelector = found.sel;
      }
    }

    if (!target) {
      domLog('warn', 'clickAndConfirm ' + label + 'target element not found in DOM');
      return {
        ok: false,
        reason: 'no_element',
        selector: null,
        elapsedMs: Date.now() - startTime,
      };
    }

    try {
      domLog('debug', 'clickAndConfirm ' + label + 'dispatching mousedown, mouseup, click' + (matchedSelector ? ' on ' + matchedSelector : ''));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      target.click();
    } catch (err) {
      domLog('error', 'clickAndConfirm ' + label + 'dispatch failed: ' + (err && err.message));
      return {
        ok: false,
        reason: 'dispatch_failed',
        selector: matchedSelector,
        elapsedMs: Date.now() - startTime,
      };
    }

    if (typeof confirms === 'function') {
      const remainingTimeout = Math.max(100, timeoutMs - (Date.now() - startTime));
      const confirmed = await waitUntil(() => confirms(target), {
        ...options,
        timeoutMs: remainingTimeout,
      });

      if (!confirmed) {
        domLog('warn', 'clickAndConfirm ' + label + 'confirmation timed out');
        return {
          ok: false,
          reason: 'predicate_timeout',
          selector: matchedSelector,
          elapsedMs: Date.now() - startTime,
        };
      }
    }

    domLog('debug', 'clickAndConfirm ' + label + 'settled successfully in ' + (Date.now() - startTime) + 'ms');
    return {
      ok: true,
      reason: 'settled',
      selector: matchedSelector,
      elapsedMs: Date.now() - startTime,
    };
  }

  /**
   * Whether an element participates in layout.
   */
  function isLaidOut(el) {
    if (!el) return false;
    try {
      return el.offsetParent !== null || el.getClientRects().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Normalises a label the same way the Node-side map does, so the two agree.
   */
  function normalizeLabelText(value) {
    return String(value == null ? '' : value)
      .replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]/g, '')
      .replace(/\\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function matchesAnyLabel(value, labels, match) {
    const haystack = normalizeLabelText(value);
    if (!haystack) return null;
    for (const label of labels) {
      const needle = normalizeLabelText(label);
      if (!needle) continue;
      const hit =
        match === 'startsWith' ? haystack.indexOf(needle) === 0
        : match === 'contains' ? haystack.indexOf(needle) !== -1
        : haystack === needle;
      if (hit) return label;
    }
    return null;
  }

  /**
   * The first signal in attrs whose value matches, or null. The name text reads
   * the element's textContent; every other name is read as an attribute.
   */
  function matchesAnyAttr(el, labels, match, attrs) {
    for (const attr of attrs) {
      const value = attr === 'text' ? el.textContent : el.getAttribute(attr);
      const hit = matchesAnyLabel(value, labels, match);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Canonicalises a locale to xx or xx-YY, or null when it names no language.
   */
  function canonicalLocale(value) {
    const parts = String(value == null ? '' : value)
      .trim()
      .toLowerCase()
      .split(/[-_]+/)
      .filter(Boolean);
    const language = parts[0];
    if (!language || !/^[a-z]{2,3}$/.test(language)) return null;
    let region = null;
    for (let i = 1; i < parts.length; i++) {
      if (/^[a-z]{2}$/.test(parts[i]) || /^[0-9]{3}$/.test(parts[i])) {
        region = parts[i].toUpperCase();
        break;
      }
    }
    return region ? language + '-' + region : language;
  }

  /**
   * The page's language, read once per call from document.documentElement.lang and
   * defaulted to en.
   */
  function pageLocale() {
    const html = document.documentElement && document.documentElement.lang;
    return canonicalLocale(html) || 'en';
  }

  /**
   * Resolves an action to an element and reports which layer matched.
   *
   * The action object and the search root are supplied by the caller, so this
   * function references no module state and the one preamble serves any app.
   */
  function findAction(root, action) {
    const miss = { el: null, via: 'none', matchedBy: null };
    const ambiguous = { el: null, via: 'ambiguous', matchedBy: null };
    if (!action || typeof action !== 'object') return miss;

    let scope = root || document;
    if (action.scope) {
      scope = scope.querySelector(action.scope);
      if (!scope) return miss;
    }

    const exclude = Array.isArray(action.exclude) ? action.exclude : [];
    const isExcluded = (el) => {
      for (const sel of exclude) {
        if (el.closest && el.closest(sel)) return true;
      }
      return false;
    };

    const selectors = Array.isArray(action.selectors) ? action.selectors : [];
    if (selectors.length > 0) {
      if (action.order === 'only') {
        // The first selector with any laid-out match sets the candidate set; a
        // second match inside it is a page change, not a silent pick.
        for (const sel of selectors) {
          const all = scope.querySelectorAll(sel);
          let match = null;
          let count = 0;
          for (const el of all) {
            if (isExcluded(el) || !isLaidOut(el)) continue;
            count += 1;
            if (!match) match = el;
          }
          if (count > 1) return ambiguous;
          if (count === 1) return { el: match, via: 'hook', matchedBy: sel };
        }
        return miss;
      }
      if (action.order === 'last') {
        for (const sel of selectors) {
          const all = scope.querySelectorAll(sel);
          for (let i = all.length - 1; i >= 0; i--) {
            const el = all[i];
            if (!isExcluded(el) && isLaidOut(el)) {
              return { el, via: 'hook', matchedBy: sel };
            }
          }
        }
        return miss;
      }
      for (const sel of selectors) {
        const el = resolveOrdered([sel], scope);
        if (el && !isExcluded(el) && isLaidOut(el)) {
          return { el, via: 'hook', matchedBy: sel };
        }
      }
      return miss;
    }

    const labelEntry = action.labels;
    if (labelEntry && typeof labelEntry === 'object') {
      // Match only the page's own language: the exact key when present, else its
      // base. The two are never merged, so a regional key overrides the base.
      const locale = pageLocale();
      const base = locale.split('-')[0];
      const wanted = locale === base ? [locale] : [locale, base];
      let labels = null;
      for (const want of wanted) {
        const found = [];
        for (const key of Object.keys(labelEntry)) {
          if (canonicalLocale(key) !== want) continue;
          const strings = labelEntry[key];
          if (Array.isArray(strings)) {
            for (const s of strings) found.push(s);
          }
        }
        if (found.length > 0) {
          labels = found;
          break;
        }
      }
      if (labels) {
        const match =
          action.match === 'startsWith' || action.match === 'contains' ? action.match : 'exact';
        // Consult only the signals the action names, in order; default all four.
        const attrs =
          Array.isArray(action.attrs) && action.attrs.length > 0
            ? action.attrs
            : ['aria-label', 'data-tooltip', 'title', 'text'];
        const wantLast = action.order === 'last';
        const wantOnly = action.order === 'only';
        let found = null;
        let count = 0;
        for (const el of scope.querySelectorAll('*')) {
          if (isExcluded(el) || !isLaidOut(el)) continue;
          const hit = matchesAnyAttr(el, labels, match, attrs);
          if (!hit) continue;
          count += 1;
          found = { el, via: 'label', matchedBy: hit };
          if (!wantLast && !wantOnly) return found;
          if (wantOnly && count > 1) return ambiguous;
        }
        if (wantOnly) return count === 1 ? found : miss;
        if (found) return found;
      }
    }

    return miss;
  }

  const primitives = { resolveOrdered, waitUntil, clickAndConfirm, findAction };
  window.__magicDomPrimitives = primitives;
  return primitives;
})();
`;
