import { CHROME_FULL_VERSION, CHROME_MAJOR_VERSION, GOOGLE_CHROME_BRAND } from './constants.js';

/**
 * The browser identity presented to Google, in the one place that owns it.
 * `session.ts` applies it to headers, `preload.ts` to the page — from the same
 * lists, so the two cannot describe different browsers.
 */

export interface UABrand {
  brand: string;
  version: string;
}

// The GREASE entry exists to stop servers hard-coding the list, so its value
// varies between Chromium releases by design. Nothing can be scored on it, which
// is why ours need not be the one this build would have generated.
const GREASE_BRAND = 'Not?A_Brand';
const GREASE_MAJOR = '24';
const GREASE_FULL = '24.0.0.0';

/**
 * The `Sec-CH-UA` list. Electron reports itself as bare `Chromium`; branded
 * Chrome also carries `Google Chrome`, and a Chrome User-Agent without it is a
 * contradiction.
 */
export function chromeBrands(): UABrand[] {
  return [
    { brand: GREASE_BRAND, version: GREASE_MAJOR },
    { brand: 'Chromium', version: CHROME_MAJOR_VERSION },
    { brand: GOOGLE_CHROME_BRAND, version: CHROME_MAJOR_VERSION },
  ];
}

/** The same list at full four-part versions, for `Sec-CH-UA-Full-Version-List`. */
export function chromeFullVersionBrands(): UABrand[] {
  return [
    { brand: GREASE_BRAND, version: GREASE_FULL },
    { brand: 'Chromium', version: CHROME_FULL_VERSION },
    { brand: GOOGLE_CHROME_BRAND, version: CHROME_FULL_VERSION },
  ];
}

/** Serialises a brand list into the structured-header form these hints use. */
export function serialiseBrands(brands: UABrand[]): string {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

interface NavigatorUAData {
  brands: UABrand[];
  mobile: boolean;
  platform: string;
  getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>;
}

/**
 * Fills in what Electron's Chromium lacks relative to branded Chrome: the
 * `Google Chrome` brand, and a `window.chrome` that is otherwise an empty object.
 *
 * Must run in the page's **main** world. Account views use
 * `contextIsolation: true`, so patches made from ordinary preload code land in
 * the isolated world and Google never sees them — which is how the headers and
 * the page came to contradict each other.
 *
 * `contextBridge.executeInMainWorld` serialises this function, so it may not
 * reference imports, module constants or any closure; hence the lists as
 * arguments. Everything else — `userAgent`, `vendor`, `webdriver`,
 * `platformVersion` — is left alone, being already correct.
 */
export function applyMainWorldIdentity(brands: UABrand[], fullVersionList: UABrand[]): void {
  try {
    const nav = navigator as Navigator & { userAgentData?: NavigatorUAData };
    const real = nav.userAgentData;

    if (real) {
      const patched: NavigatorUAData & { toJSON: () => unknown } = {
        brands,
        mobile: real.mobile,
        platform: real.platform,
        getHighEntropyValues: (hints: string[]) =>
          real.getHighEntropyValues(hints).then((values) => {
            const out: Record<string, unknown> = { ...values, brands };
            if (values.fullVersionList) out.fullVersionList = fullVersionList;
            if (values.uaFullVersion) out.uaFullVersion = fullVersionList[1].version;
            return out;
          }),
        toJSON: () => ({ brands, mobile: real.mobile, platform: real.platform }),
      };

      Object.defineProperty(nav, 'userAgentData', {
        get: () => patched,
        configurable: true,
      });
    }
  } catch {
    // Ignore
  }

  try {
    const win = window as Window & { chrome?: Record<string, unknown> };
    if (win.chrome && Object.keys(win.chrome).length === 0) {
      const seconds = () => Date.now() / 1000;
      Object.assign(win.chrome, {
        app: {
          isInstalled: false,
          InstallState: {
            DISABLED: 'disabled',
            INSTALLED: 'installed',
            NOT_INSTALLED: 'not_installed',
          },
          RunningState: {
            CANNOT_RUN: 'cannot_run',
            READY_TO_RUN: 'ready_to_run',
            RUNNING: 'running',
          },
          getDetails: () => null,
          getIsInstalled: () => false,
          runningState: () => 'cannot_run',
        },
        csi: () => ({
          onloadT: Date.now(),
          pageT: performance.now(),
          startE: Date.now() - Math.round(performance.now()),
          tran: 15,
        }),
        loadTimes: () => ({
          commitLoadTime: seconds(),
          connectionInfo: 'h2',
          finishDocumentLoadTime: seconds(),
          finishLoadTime: seconds(),
          firstPaintAfterLoadTime: 0,
          firstPaintTime: seconds(),
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: seconds(),
          startLoadTime: seconds(),
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        }),
      });
    }
  } catch {
    // Ignore
  }
}
