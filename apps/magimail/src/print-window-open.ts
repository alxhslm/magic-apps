/**
 * Wraps `window.open` in the page's main world so denied Gmail print view
 * opens (`view=pt`) return a stub `Window`-like object instead of `null`.
 *
 * `AccountsManager` intercepts `view=pt` in `setWindowOpenHandler`, triggers
 * `printUrl()`, and returns `{ action: 'deny' }` so no visible popup appears.
 * Returning `null` from `window.open` causes Gmail's client script to show an
 * in-page pop-up blocker error.
 *
 * `contextBridge.executeInMainWorld` serialises this function, so it must not
 * reference imports, module constants, or closures.
 */
export function installMainWorldPrintOpenStub(): void {
  try {
    const win = window as Window & { __magimailPrintOpenStubInstalled?: boolean };
    if (win.__magimailPrintOpenStubInstalled || typeof win.open !== 'function') {
      return;
    }
    win.__magimailPrintOpenStubInstalled = true;

    const originalOpen = win.open;
    win.open = function (
      url?: string | URL,
      target?: string,
      features?: string,
    ): WindowProxy | null {
      const opened = originalOpen.call(win, url, target, features);
      if (opened) {
        return opened;
      }

      if (url === undefined || url === null) {
        return opened;
      }

      let isPrintView = false;
      try {
        const parsed = new URL(String(url), win.location.href);
        isPrintView =
          (parsed.hostname === 'mail.google.com' || parsed.hostname.endsWith('.mail.google.com')) &&
          parsed.searchParams.get('view') === 'pt';
      } catch {
        isPrintView = String(url).includes('view=pt');
      }

      if (!isPrintView) {
        return opened;
      }

      return {
        closed: false,
        focus: () => {},
        blur: () => {},
        close: () => {},
        print: () => {},
        postMessage: () => {},
      } as unknown as WindowProxy;
    };
  } catch {
    // Ignore
  }
}
