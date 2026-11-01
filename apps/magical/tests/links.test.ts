import { describe, it, expect, vi, beforeEach } from 'vitest';

const openExternal = vi.fn();
vi.mock('electron', () => ({
  shell: { openExternal: (url: string) => openExternal(url) },
}));

const hasApplicationForUrl = vi.fn((_url: string) => true);
vi.mock('../src/native-handlers.js', () => ({
  hasApplicationForUrl: (url: string) => hasApplicationForUrl(url),
}));

const alwaysJoinInBrowser = vi.fn(() => false);
const openTodoistInDesktopApp = vi.fn(() => true);
vi.mock('../src/settings-store.js', () => ({
  loadSettings: () => ({
    alwaysJoinInBrowser: alwaysJoinInBrowser(),
    openTodoistInDesktopApp: openTodoistInDesktopApp(),
  }),
}));

import {
  isInternalUrl,
  openExternalUrl,
  toNativeMeetingUrl,
  toNativeTodoistUrl,
  unwrapRedirectors,
  withoutQuery,
} from '../src/links.js';

describe('isInternalUrl', () => {
  it('keeps Google Calendar and the sign-in flow in the app', () => {
    expect(isInternalUrl('https://calendar.google.com/calendar/r/week')).toBe(true);
    expect(isInternalUrl('https://accounts.google.com/ServiceLogin?service=cl')).toBe(true);
    expect(isInternalUrl('https://myaccount.google.com/security')).toBe(true);
  });

  it('sends event attachments and locations to the browser', () => {
    expect(isInternalUrl('https://drive.google.com/file/d/abc/view')).toBe(false);
    expect(isInternalUrl('https://www.google.com/maps/place/Blue+Bottle')).toBe(false);
    expect(isInternalUrl('https://meet.google.com/abc-defg-hij')).toBe(false);
  });

  it('does not match an origin by prefix', () => {
    // A lookalike host that starts with the real one would pass a
    // `startsWith` check; origin comparison is what stops it.
    expect(isInternalUrl('https://calendar.google.com.evil.test/calendar/r')).toBe(false);
  });

  it('treats http as external even on a Google host', () => {
    expect(isInternalUrl('http://calendar.google.com/calendar/r')).toBe(false);
  });

  it('is false for anything that is not a URL', () => {
    expect(isInternalUrl('javascript:alert(1)')).toBe(false);
    expect(isInternalUrl('not a url')).toBe(false);
    expect(isInternalUrl('')).toBe(false);
  });
});

describe('withoutQuery', () => {
  it('drops the query a cold start leaves on the calendar URL', () => {
    expect(withoutQuery('https://calendar.google.com/calendar/u/0/r?pli=1')).toBe(
      'https://calendar.google.com/calendar/u/0/r',
    );
  });

  it('keeps the path, which is where the date and the view mode live', () => {
    expect(withoutQuery('https://calendar.google.com/calendar/u/0/r/month/2026/9/1?tab=rc')).toBe(
      'https://calendar.google.com/calendar/u/0/r/month/2026/9/1',
    );
  });

  it('leaves a URL with no query alone', () => {
    const url = 'https://calendar.google.com/calendar/u/0/r/week';
    expect(withoutQuery(url)).toBe(url);
  });

  it('returns anything unparseable unchanged', () => {
    expect(withoutQuery('not a url')).toBe('not a url');
  });
});

describe('toNativeMeetingUrl', () => {
  it('rewrites Zoom web links to native scheme', () => {
    expect(toNativeMeetingUrl('https://zoom.us/j/1234567890')).toBe(
      'zoommtg://zoom.us/join?action=join&confno=1234567890',
    );
  });

  it('rewrites Teams web links to native scheme', () => {
    expect(toNativeMeetingUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x')).toBe(
      'msteams://teams.microsoft.com/l/meetup-join/19%3ameeting_x',
    );
  });
});

describe('toNativeTodoistUrl', () => {
  it('rewrites task links to todoist://task?id=', () => {
    expect(toNativeTodoistUrl('https://app.todoist.com/app/task/6372819283')).toBe(
      'todoist://task?id=6372819283',
    );
    expect(toNativeTodoistUrl('https://todoist.com/showTask?id=6372819283')).toBe(
      'todoist://task?id=6372819283',
    );
  });

  it('rewrites project links to todoist://project?id=', () => {
    expect(toNativeTodoistUrl('https://app.todoist.com/app/project/22334455')).toBe(
      'todoist://project?id=22334455',
    );
    expect(toNativeTodoistUrl('https://todoist.com/showProject?id=22334455')).toBe(
      'todoist://project?id=22334455',
    );
  });

  it('preserves non-task and non-project links', () => {
    expect(toNativeTodoistUrl('https://app.todoist.com/app/today')).toBe(
      'https://app.todoist.com/app/today',
    );
    expect(toNativeTodoistUrl('https://example.com')).toBe('https://example.com');
  });

  it('unwraps Google redirector URLs before rewriting', () => {
    expect(
      toNativeTodoistUrl(
        'https://www.google.com/url?q=https://app.todoist.com/app/task/6c33mFGQvgx4Qmmc&usd=1&usg=2',
      ),
    ).toBe('todoist://task?id=6c33mFGQvgx4Qmmc');
    expect(
      toNativeTodoistUrl(
        'https://www.google.com/url?q=https://app.todoist.com/app/project/99887766&usd=1',
      ),
    ).toBe('todoist://project?id=99887766');
  });
});

describe('unwrapRedirectors', () => {
  it('unwraps Google outbound URLs', () => {
    expect(unwrapRedirectors('https://www.google.com/url?q=https://example.com/page&usd=1')).toBe(
      'https://example.com/page',
    );
    expect(unwrapRedirectors('https://google.com/url?url=https://example.com/page')).toBe(
      'https://example.com/page',
    );
  });

  it('unwraps Outlook safelinks', () => {
    expect(
      unwrapRedirectors(
        'https://eur02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com&data=1',
      ),
    ).toBe('https://example.com');
  });

  it('returns plain URLs unchanged', () => {
    expect(unwrapRedirectors('https://example.com')).toBe('https://example.com');
  });
});

describe('openExternalUrl', () => {
  beforeEach(() => {
    openExternal.mockClear();
    hasApplicationForUrl.mockClear();
    hasApplicationForUrl.mockReturnValue(true);
    alwaysJoinInBrowser.mockReturnValue(false);
    openTodoistInDesktopApp.mockReturnValue(true);
  });

  it('opens Todoist task link in desktop app when available', async () => {
    await openExternalUrl('https://app.todoist.com/app/task/6372819283');
    expect(hasApplicationForUrl).toHaveBeenCalledWith('todoist://task?id=6372819283');
    expect(openExternal).toHaveBeenCalledWith('todoist://task?id=6372819283');
  });

  it('unwraps and opens Google redirector wrapped Todoist task links', async () => {
    await openExternalUrl(
      'https://www.google.com/url?q=https://app.todoist.com/app/task/6c33mFGQvgx4Qmmc&usd=123',
    );
    expect(hasApplicationForUrl).toHaveBeenCalledWith('todoist://task?id=6c33mFGQvgx4Qmmc');
    expect(openExternal).toHaveBeenCalledWith('todoist://task?id=6c33mFGQvgx4Qmmc');
  });

  it('falls back to browser when Todoist app is missing', async () => {
    hasApplicationForUrl.mockReturnValue(false);
    await openExternalUrl('https://app.todoist.com/app/task/6372819283');
    expect(openExternal).toHaveBeenCalledWith('https://app.todoist.com/app/task/6372819283');
  });

  it('falls back to browser when Todoist app throws on open', async () => {
    openExternal.mockRejectedValueOnce(new Error('Failed to open'));
    await openExternalUrl('https://app.todoist.com/app/task/6372819283');
    expect(openExternal).toHaveBeenNthCalledWith(1, 'todoist://task?id=6372819283');
    expect(openExternal).toHaveBeenNthCalledWith(2, 'https://app.todoist.com/app/task/6372819283');
  });

  it('leaves web link untouched if openTodoistInDesktopApp is false', async () => {
    openTodoistInDesktopApp.mockReturnValue(false);
    await openExternalUrl('https://app.todoist.com/app/task/6372819283');
    expect(hasApplicationForUrl).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://app.todoist.com/app/task/6372819283');
  });

  it('opens regular external link in browser', async () => {
    await openExternalUrl('https://github.com/alxhslm/magic-apps');
    expect(hasApplicationForUrl).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://github.com/alxhslm/magic-apps');
  });
});
