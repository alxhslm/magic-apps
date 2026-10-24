import { describe, it, expect } from 'vitest';
import {
  getGmailCustomCss,
  getGmailDarkModeCss,
  getGmailLightModeCss,
  getHideAdsCss,
  getHideSidebarCss,
  getSubframeDarkModeCss,
  getSubframeLightModeCss,
  RESTORE_FILTER,
} from '../src/css.js';

describe('getGmailCustomCss', () => {
  it('hides chrome download banners', () => {
    const css = getGmailCustomCss();
    expect(css).toContain('div[role="alert"]:has(a[href*="google.com/chrome"])');
  });

  it('includes refined scrollbars', () => {
    const css = getGmailCustomCss();
    expect(css).toContain('::-webkit-scrollbar');
  });

  it('ensures settings panel and opened companion panel retain solid backgrounds, while collapsed sidebar is clear', () => {
    const css = getGmailCustomCss();
    // The Quick-settings dropdown is a map action, so its clause carries the :lang() scope.
    expect(css).toContain('quick settings');
    expect(css).toContain(':lang(en)');
    expect(css).toContain('div[role="complementary"]');
    expect(css).toContain('div[role="tabpanel"]:has(iframe)');
    expect(css).toContain('background-color: #ffffff !important;');
    expect(css).toContain('background-color: transparent !important;');
  });

  it('scopes decoration panel classes strictly to empty divs', () => {
    const css = getGmailCustomCss();
    expect(css).toContain('div.wl:empty');
    expect(css).toContain('div.wq:empty');
    expect(css).not.toContain('div[role="main"] div.wl');
  });

  it('includes clean print media styles hiding UI chrome and expanding main email content', () => {
    const css = getGmailCustomCss();
    expect(css).toContain('@media print');
    expect(css).toContain('div[role="navigation"]');
    expect(css).toContain('header[role="banner"]');
    expect(css).toContain('div[role="complementary"]');
    expect(css).toContain('div[role="main"]');
    expect(css).toContain('display: none !important;');
  });
});

describe('getGmailDarkModeCss and getGmailLightModeCss', () => {
  it('counter-inverts companion sidebar tab icons generically in dark mode while excluding generic add-ons', () => {
    const css = getGmailDarkModeCss();
    expect(css).toContain(
      'div[role="complementary"] [role="tab"]:not(:is([aria-label*="add-on" i]:lang(en)',
    );
    expect(css).toContain(RESTORE_FILTER);
  });

  it('resets companion sidebar tab icons in light mode', () => {
    const css = getGmailLightModeCss();
    expect(css).toContain('div[role="complementary"] [role="tab"] [style*="background-image"]');
    expect(css).toContain('filter: none !important;');
  });

  it('lets monochrome action button, thread control, and toolbar icons invert to white in dark mode', () => {
    const darkCss = getGmailDarkModeCss();
    expect(darkCss).toContain('[role="toolbar"] svg');
    expect(darkCss).toContain('[role="button"] svg');
    expect(darkCss).toContain('[role="link"] svg');
    expect(darkCss).toContain('[role="checkbox"] svg');
    expect(darkCss).toContain('button svg');
    expect(darkCss).toContain('a svg');
    expect(darkCss).toContain('img[src*="cleardot"]');
    expect(darkCss).toContain('div[role="main"] svg');

    const lightCss = getGmailLightModeCss();
    expect(lightCss).toContain('[role="toolbar"] svg');
    expect(lightCss).toContain('img[src*="cleardot"]');
    expect(lightCss).toContain('a svg');
    expect(lightCss).toContain('div[role="main"] svg');
  });

  it('counter-inverts real images so avatars, logos and mail content keep true colours', () => {
    // Comments are stripped so the assertion reads the rules, not the prose
    // explaining why these selectors are wrong.
    const rules = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const css of [rules(getGmailDarkModeCss()), rules(getSubframeDarkModeCss())]) {
      // Exempting images by container is what inverted the account avatar and
      // the Gmail lockup; only cleardot sprites may skip the restore.
      for (const selector of [
        '[aria-label] img',
        '[role="button"] img',
        '[role="toolbar"] img',
        'a img',
        'button img',
        '[data-tooltip] img',
        'div[role="main"] [role="button"] *',
        'div[role="main"] [aria-label] *',
      ]) {
        expect(css).not.toContain(selector);
      }
    }
  });

  it('restores the Ask Gemini brand gradient from the locale map, scoped by language', () => {
    const darkCss = getGmailDarkModeCss();
    expect(darkCss).toContain('header[role="banner"] div:has(> * > :is(');
    expect(darkCss).toContain('header[role="banner"] :is(');
    expect(darkCss).toContain('[aria-label="ask gemini" i]:lang(en)');
    expect(darkCss).toContain(RESTORE_FILTER);

    const lightCss = getGmailLightModeCss();
    expect(lightCss).toContain('header[role="banner"] div:has(> * > :is(');
    expect(lightCss).toContain('[aria-label="ask gemini" i]:lang(en)');
  });
});

describe('getSubframeDarkModeCss and getSubframeLightModeCss', () => {
  it('counter-inverts subframe media, background images, and sprite spans in dark mode', () => {
    const css = getSubframeDarkModeCss();
    expect(css).toContain('img, video, canvas, svg');
    expect(css).toContain('[style*="background-image"]');
    expect(css).toContain('a span[style*="background"]');
    expect(css).toContain(RESTORE_FILTER);
  });

  it('resets subframe media and icons in light mode', () => {
    const css = getSubframeLightModeCss();
    expect(css).toContain('img, video, canvas, svg');
    expect(css).toContain('filter: none !important;');
  });
});

describe('getHideAdsCss', () => {
  it('does NOT contain tr.zA.zE (which represents unread email messages)', () => {
    const css = getHideAdsCss();
    expect(css).not.toContain('tr.zA.zE');
    expect(css).not.toContain('.zE');
  });

  it('targets semantic ad markers from the locale map, each scoped by language', () => {
    const css = getHideAdsCss();
    // Every clause is a `:lang()`-scoped fragment the map generated, so a row is
    // hidden on whatever the page's own language calls an ad, not only English.
    expect(css).toContain('tr[role="row"]:has([aria-label*="ad info" i]:lang(en))');
    expect(css).toContain('tr[role="row"]:has([data-tooltip*="about this ad" i]:lang(en))');
    expect(css).toContain('tr[role="row"]:has([title*="why this ad" i]:lang(en))');
    expect(css).toContain('tr[role="row"]:has([aria-label="ad" i]:lang(en))');
    expect(css).toContain('tr[role="row"]:has([aria-label="sponsored" i]:lang(en))');
    expect(css).toContain('tr[role="row"]:has([aria-label*="sponsored" i]:lang(en))');
    expect(css).not.toContain('tr:has(td:last-child [aria-haspopup="dialog"])');
    expect(css).not.toContain('tr.zA.zE');
    expect(css).toContain('display: none !important;');
  });

  it('never emits a bare contains-"ad" clause, which would match "read" and hide the inbox', () => {
    const css = getHideAdsCss();
    // "ad" is a substring of "Mark as unread"; a bare `*= "ad"` clause matched
    // 100 of 100 inbox rows. The only `contains "ad"` is behind the ad badge's
    // aria-haspopup="dialog".
    for (const attr of ['aria-label', 'data-tooltip', 'title']) {
      expect(css).not.toContain(`tr[role="row"]:has([${attr}*="ad" i]:lang(en))`);
    }
    expect(css).toContain(
      'tr[role="row"]:has([aria-haspopup="dialog"]:is([aria-label*="ad" i]:lang(en)',
    );
  });
});

describe('getHideSidebarCss', () => {
  it('uses semantic ARIA role selector for companion sidebar and toggle arrow, and does not use minified classes', () => {
    const css = getHideSidebarCss();
    expect(css).toContain('div:has(> [role="complementary"])');
    expect(css).toContain('[role="complementary"]');
    // The toggle is reached by its localised label, scoped to the label's language.
    expect(css).toContain('[role="button"]:is([aria-label="show side panel" i]:lang(en)');
    expect(css).toContain('[aria-label="hide side panel" i]:lang(en)');
    expect(css).not.toContain('.aUx');
    expect(css).not.toContain('.bAw');
    expect(css).not.toContain('div[role="navigation"]');
  });
});

describe('folding the Categories section', () => {
  it('hides the category rows on a class rather than by removing them', () => {
    const css = getGmailCustomCss();
    // The rows have to survive the fold: the sidebar unread observer reads its
    // counts off them, and Gmail's own fold takes them out of the DOM.
    expect(css).toContain('html.magimail-categories-collapsed [data-magimail-category-row]');
    expect(css).toContain('display: none !important');
    // Gmail still draws its own control open, so the arrow is turned here.
    expect(css).toContain('html.magimail-categories-collapsed [data-magimail-categories-toggle]');
    expect(css).toContain('rotate(-90deg)');
  });
});
