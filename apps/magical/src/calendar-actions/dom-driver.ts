import type { WebContentsView, WebFrameMain } from 'electron';
import { CALENDAR_APP_URL } from '../constants.js';
import { DOM_DRIVE_PREAMBLE, viewIsAlive } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { decodeEid } from '../event-links.js';
import { domAction, domSelector } from '../dom-labels.js';
import { calendarRoot, pathnameOf, viewModeForPath, type ViewMode } from '../calendar-routes.js';
import type { RevealOutcome } from '../accounts-manager.js';
import type {
  CalendarActionDriver,
  CalendarActionOutcome,
  RsvpResponse,
  RsvpTiming,
} from './types.js';

const log = createLogger('Accounts');

/**
 * What the driver needs from the window that owns the views.
 *
 * The driver owns every page interaction. What it cannot own is the lifetime of the view
 * it drives: whether an account is awake, which view is on screen, and the lock that
 * keeps two actions off one page are window state, so they are asked for here.
 */
export interface DomActionHost {
  /** Whether the account is still signed in. */
  hasAccount(accountId: string): boolean;

  /** The account on screen, which an action with no explicit target applies to. */
  activeAccountId(): string;

  /** The mode an account was last seen in, for an action on a suspended view. */
  viewMode(accountId: string): ViewMode;

  /** The account's view if it is awake. */
  viewFor(accountId: string): WebContentsView | undefined;

  /** Serialises actions per account. */
  withActionLock<T>(accountId: string, label: string, run: () => Promise<T>): Promise<T>;

  /**
   * The account's view, woken for an action, and the release that puts it back.
   *
   * `waitForLoad` is false when the caller navigates anyway: the page being replaced
   * does not have to finish first.
   */
  wake(
    accountId: string,
    waitForLoad?: boolean,
  ): Promise<{ view: WebContentsView; release: () => void } | undefined>;

  /** The view's document has finished loading. */
  waitForPage(view: WebContentsView, timeoutMs?: number): Promise<boolean>;

  /** Follows a navigation and reports whether the view arrived. */
  onNavigated?(accountId: string, url: string): void;
}

/**
 * The delete control in an event's detail panel.
 *
 * One authored id: `#xDetDlgDelBu` is the panel's own Delete. The preview and full
 * editor spellings the old list fell back to (`#xPrvDelBu`, `#xDelBu`) were not present
 * on a live signed-in calendar, and the editor now carries no delete control at all, so
 * the confirmed id is the only one kept; see `dom-labels.json`.
 */
const DELETE_CONTROL = domSelector('deleteEvent');

/**
 * The OK in the modal that asks how much of a recurring event an action covers.
 *
 * Both a delete and an answer raise one: "Delete recurring event" and "RSVP to
 * recurring event". Its OK carries no id, no `jsname` and no accessible name beyond
 * the localised "OK". It is a Material dialog, and MDC marks the default button with
 * `data-mdc-dialog-action="ok"`, a stable hand-authored hook that no locale changes.
 * The detail panel is a `[role="dialog"]` too, but its buttons carry no
 * `data-mdc-dialog-action`, so the scope keeps this to the modal. See
 * `dom-labels.json`.
 */
const CONFIRM_SCOPE_CONTROL = domSelector('confirmScope');

/**
 * The occurrence option in that modal.
 *
 * Its two choices are "This event" and "All events", and neither carries an accessible
 * name: the radios have no `aria-label` and no id, and their `name` and `value` are
 * compiler output. Their order is the only stable thing about them, and Google offers the
 * narrower one first, which is the choice its own default makes. See `dom-labels.json`.
 */
const SCOPE_INSTANCE_CONTROL = domSelector('scopeInstance');

/**
 * The control that ticks a task off, inside its open detail panel.
 *
 * `data-completed` is the attribute Google's own button carries, and it holds the state
 * as well as marking the control: `false` on an open task, `true` once it is done. The
 * button is labelled "Mark completed" and nothing else, so matching the text would tie
 * the feature to an English Calendar.
 */
const COMPLETE_CONTROL = '[role="dialog"] button[data-completed]';

/** Quotes a value for use inside an attribute selector. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * The chips that belong to one event, matched on every id Google draws it under.
 *
 * An ordinary event's chip carries the `eid` itself, so most of this is an equality match.
 *
 * A task's chip is `ttb_` followed by the `eid`, while the `eid=` in the task's own link
 * carries no prefix at all. The poller reads the link, so the id it hands on matches no
 * chip in the grid and every reveal and delete of a task finds nothing to click. Both
 * forms are matched rather than the event's kind consulted, because an event whose
 * `eventType` never arrived would otherwise be back where it started; an ordinary event's
 * `eid` never gains a `ttb_` chip, so accepting the prefix costs nothing.
 *
 * A working location's chip carries neither. Its `data-eventid` is a composite Calendar
 * builds out of `_WL_`, the entry's millisecond stamps, its calendar and its ids, and the
 * only part the poller also holds is the event id out of the `eid`. That id is matched
 * where it sits rather than the whole composite rebuilt, which would mean reproducing the
 * stamps; those are the entry's wall-clock time written as though it were UTC, and getting
 * the offset wrong is a silent miss of exactly the kind this replaces.
 *
 * Where it sits depends on the entry. A one-off ends on it:
 *
 *     _WL_<startMs>__<endMs>__<base64 calendarId>__<eventId>
 *
 * while a recurring one carries its series id and an occurrence id around it, so the
 * event id lands in the middle with more to follow:
 *
 *     _WL_<startMs>__<endMs>__<base64 calendarId>__<seriesId>_<date>__<eventId>__<occurrenceId>
 *
 * Both are matched, under the `_WL_` prefix so neither clause can reach an ordinary chip,
 * whose base64url can contain `__` of its own. The middle clause is bounded by `__` on
 * both sides so it cannot match an id that merely starts the same way.
 *
 * Measured against a live account: a one-off working location, all-day and timed alike,
 * and a recurring one.
 */
function chipSelector(eid: string): string {
  const id = cssEscape(eid);
  const known = `[data-eventid="${id}"],[data-eventid="ttb_${id}"]`;
  const eventId = decodeEid(eid)?.eventId;
  if (!eventId) return known;
  const wlId = cssEscape(eventId);
  return (
    `${known},[data-eventid^="_WL_"][data-eventid$="__${wlId}"]` +
    `,[data-eventid^="_WL_"][data-eventid*="__${wlId}__"]`
  );
}

const VIEW_KEY_PATHS: Readonly<Record<string, string>> = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  CUSTOM_DAYS: 'customday',
  CUSTOM_WEEKS: 'customweek',
};

/**
 * The map actions `triggerCalendarAction` drives, embedded whole into its page script.
 *
 * The Create button has no `aria-label`: its accessible name is computed from the
 * "Create" its Material icons leave in the button's text, which is no use to a
 * selector. `[aria-haspopup="menu"]` is the strong hook it does carry, and
 * `data-is-drawer-closed` is the toolbar that the value names — the only other
 * `aria-haspopup="menu"` controls on the page (the view switcher, Settings and Add
 * other calendars) sit outside it, so the scope narrows four matches to one.
 */
const TRIGGER_ACTIONS = {
  create: domAction('create'),
  createEvent: domAction('createEvent'),
  createTask: domAction('createTask'),
  addTaskButton: domAction('addTaskButton'),
  addTaskField: domAction('addTaskField'),
  searchInput: domAction('searchInput'),
  searchButton: domAction('searchButton'),
  closeEventDialog: domAction('closeEventDialog'),
  back: domAction('back'),
  today: domAction('today'),
  navPrev: domAction('navPrev'),
  navNext: domAction('navNext'),
};

/** Why an RSVP did or did not land. `busy` is retryable; `failed` is not. */
export type RsvpOutcome = 'ok' | 'busy' | 'failed';

export class DomCalendarActionDriver implements CalendarActionDriver {
  constructor(private readonly host: DomActionHost) {}

  public async performRsvp(
    _view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    response: RsvpResponse,
    startTime: Date,
    _timing?: RsvpTiming,
  ): Promise<CalendarActionOutcome> {
    log.info(`Performing RSVP ${response} on ${accountId}`);
    return this.host.withActionLock(accountId, `rsvp:${response}`, async () => {
      if (!this.host.hasAccount(accountId)) {
        log.warn(`RSVP ${response} failed: account ${accountId} not found`);
        return 'failed';
      }

      const woken = await this.host.wake(accountId, false);
      if (!woken) {
        log.warn(`RSVP ${response} failed: no view available for ${accountId}`);
        return 'failed';
      }
      const { view, release } = woken;

      if (!(await this.waitForCalendarGrid(view, accountId))) {
        log.warn(`Calendar did not finish loading for ${accountId}; RSVP cannot proceed`);
        release();
        return 'failed';
      }

      // Routing while an editor is open is destructive in a way that is easy to miss.
      // `pushState` changes the URL unilaterally, so Calendar's own unsaved-changes guard
      // cannot veto it: the user gets a "Discard unsaved changes?" alert, the page moves
      // behind it, and the URL ends up naming the day view while the editor is still on
      // screen. Measured. So the caller is told to come back later rather than acted upon.
      if (await this.isBusyEditing(view)) {
        log.info(`RSVP ${response} on ${accountId} held: view is busy editing`);
        release();
        return 'busy';
      }

      const previousPath = await this.currentPath(view);
      let routedToDay: string | null = null;
      try {
        const alreadyHasChip = await this.hasEventChip(view, eid);
        if (!alreadyHasChip) {
          const day = this.pathForDate(previousPath, startTime, await this.currentViewMode(view));
          if (!(await this.routeTo(view, day))) {
            log.warn(`RSVP ${response} on ${accountId} failed: could not route to day ${day}`);
            return 'failed';
          }
          routedToDay = day;
        }
        if (!(await this.openEventChip(view, eid))) {
          log.warn(
            `RSVP ${response} on ${accountId} failed: could not open the event chip (${decodeEid(eid)?.eventId ?? 'unresolved'})`,
          );
          return 'failed';
        }
        const confirmed = await this.clickRsvpControl(view, response);
        if (!confirmed) {
          log.warn(
            `RSVP ${response} on ${accountId} failed: control click or confirmation was not observed`,
          );
          return 'failed';
        }
        log.info(`RSVP ${response} on ${accountId} succeeded`);
        return 'ok';
      } catch (err) {
        log.error(`RSVP ${response} on ${accountId} threw an error:`, err);
        return 'failed';
      } finally {
        // Never strand the view on a day the user did not ask to see, but do not
        // overwrite where they are if they navigated elsewhere in the interim.
        if (routedToDay && previousPath) {
          const current = await this.currentPath(view);
          if (current && current.includes(routedToDay)) {
            void this.routeTo(view, previousPath).catch(() => {});
          }
        }
        release();
      }
    });
  }

  /**
   * Shows one event in its own account's view, with its detail panel open.
   *
   * What a banner does when the user clicks its body, and deliberately the same
   * machinery as `performRsvp`: route the document rather than reload it, then click the
   * chip as a user would. Loading the event's edit URL instead would open the editor
   * over the grid and tear down whatever was already open.
   *
   * The account's current view mode is preserved, because arriving in day view when the
   * user works in week view is a worse answer than arriving in the week that contains
   * the event. The path is left where the event is, unlike `performRsvp`, which restores
   * it: being taken to the event is the whole point of following the link.
   */
  public async revealEvent(
    _view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    at: Date,
  ): Promise<RevealOutcome> {
    log.info(`Revealing event on ${accountId} (${decodeEid(eid)?.eventId ?? 'unresolved'})`);
    if (!this.host.hasAccount(accountId)) {
      log.warn(`Reveal failed: account ${accountId} not found`);
      return 'failed';
    }

    const woken = await this.host.wake(accountId, false);
    if (!woken) {
      log.warn(`No view to reveal ${accountId} in`);
      return 'failed';
    }
    const { view, release } = woken;

    // A suspended account has no page yet, and this is the common case: the link arrives
    // from a banner, which is exactly when the user has not been looking at the account.
    // Routing a blank document succeeds and then finds nothing.
    if (!(await this.waitForCalendarGrid(view, accountId))) {
      log.warn('Calendar did not finish loading; nothing to reveal into');
      release();
      return 'failed';
    }

    // Same reasoning as an RSVP: a route change behind an open editor leaves the user
    // with a discard prompt over a page that has already moved.
    if (await this.isBusyEditing(view)) {
      log.info(`Reveal event on ${accountId} held: view is busy editing`);
      release();
      return 'busy';
    }

    try {
      const path = this.pathForDate(
        await this.currentPath(view),
        at,
        await this.currentViewMode(view),
      );
      if (!(await this.routeTo(view, path))) {
        log.warn(`Could not route to ${path}`);
        return 'failed';
      }
      if (!(await this.clickEventChip(view, eid))) {
        log.info(`Reveal event on ${accountId}: routed to day, chip not clicked`);
        return 'routed';
      }

      // The panel animates in, so its absence on the next tick means nothing. Waiting is
      // what separates a click Calendar acted on from one it swallowed.
      if (await this.waitFor(view, '[role="dialog"]')) {
        log.info(`Reveal event on ${accountId}: revealed dialog`);
        return 'revealed';
      }

      log.warn('Clicked the event chip but no panel opened');
      return 'routed';
    } catch (err) {
      log.error(`Reveal event on ${accountId} threw an error:`, err);
      return 'failed';
    } finally {
      release();
    }
  }

  /**
   * Leaves full-screen Tasks for the calendar, when the view is on the Tasks route.
   *
   * The switcher that would take the user back is hidden when "Hide Tasks tab" is on, so
   * leaving them there strands them. A route rather than a reload, so the account keeps
   * its view mode and an open draft is not torn down.
   */
  public async leaveTasksRouteIfActive(view: WebContentsView): Promise<void> {
    const path = await this.currentPath(view);
    if (!path || !/\/r\/tasks\b/.test(path)) return;
    if (!(await this.routeTo(view, calendarRoot(path)))) {
      log.warn('Could not leave the Tasks route after hiding the Tasks tab');
    }
  }

  /**
   * The path that shows a date in the view the user is already using.
   *
   * Calendar's route is `/calendar/u/<n>/r/<mode>/<y>/<m>/<d>`, and the mode is reused so
   * that following a link moves the user in time rather than also changing how they are
   * looking at their week: arriving in day view when the user works in week view is a
   * worse answer than arriving in the week that contains the event. Preserving it is only
   * safe because the chip is addressed as an element: a mode whose grid scrolls puts
   * chips at coordinates no click could reach.
   *
   * `fallbackMode` is consulted only when the path itself does not name a view, which is
   * the normal state for an account woken by a link: Calendar resumes at
   * `/calendar/u/<n>/r`, whose default view is a user setting the URL never mentions.
   * Defaulting to `day` there moves anyone whose default is a week or a month out of it,
   * to show them one event.
   */
  private pathForDate(currentPath: string | null, at: Date, fallbackMode?: string): string {
    const mode =
      /\/r\/(day|week|month|year|customday|customweek|agenda|schedule)\b/.exec(
        currentPath ?? '',
      )?.[1] ??
      fallbackMode ??
      'day';
    return `${calendarRoot(currentPath)}/${mode}/${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()}`;
  }

  /**
   * Navigates the active Calendar view to a specified date.
   */
  public async navigateToDate(view: WebContentsView, date: Date, mode?: string): Promise<boolean> {
    const current = await this.currentPath(view);
    const targetMode = mode ?? (await this.currentViewMode(view)) ?? 'day';
    const path = `${calendarRoot(current)}/${targetMode}/${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
    return this.routeTo(view, path);
  }

  /**
   * The view Calendar is rendering, as a route segment.
   *
   * Read from `data-viewkey` rather than from the title, which is a localised date
   * string, or from the path, which is empty on the view an account resumes into.
   * Null when the view draws no event chips, so the caller routes to a view that does
   * rather than to one where there is nothing to click.
   */
  private async currentViewMode(view: WebContentsView): Promise<string | undefined> {
    try {
      const key: string | null = await view.webContents.executeJavaScript(`
        (document.querySelector('[data-viewkey]') || {}).dataset?.viewkey ?? null
      `);
      return key ? VIEW_KEY_PATHS[key] : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Deletes an event using CalendarActionDriver (sync API first, DOM fallback).
   */
  public async deleteEvent(
    _view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    startTime: Date,
    isTask = false,
  ): Promise<'ok' | 'busy' | 'failed'> {
    log.info(`Deleting event on ${accountId} (isTask: ${isTask})`);
    return this.host.withActionLock(accountId, 'delete', async () => {
      if (!this.host.hasAccount(accountId)) {
        log.warn(`Delete failed: account ${accountId} not found`);
        return 'failed';
      }

      const woken = await this.host.wake(accountId, false);
      if (!woken) {
        log.warn(`Delete failed: no view available for ${accountId}`);
        return 'failed';
      }
      const { view, release } = woken;

      if (!(await this.waitForCalendarGrid(view, accountId))) {
        log.warn(`Calendar did not finish loading for ${accountId}; delete cannot proceed`);
        release();
        return 'failed';
      }

      if (await this.isBusyEditing(view)) {
        log.info(`Delete event on ${accountId} held: view is busy editing`);
        release();
        return 'busy';
      }

      const previousPath = await this.currentPath(view);
      let routedToPath: string | null = null;
      try {
        const alreadyHasChip = await this.hasEventChip(view, eid);
        if (!alreadyHasChip) {
          const day = this.pathForDate(previousPath, startTime, await this.currentViewMode(view));
          if (await this.routeTo(view, day)) {
            routedToPath = day;
            if (await this.openEventChipForDelete(view, eid)) {
              if (await this.clickDeleteControl(view)) {
                log.info(`Delete event on ${accountId} succeeded via day view`);
                return 'ok';
              }
            }
          }

          log.warn(`Delete event on ${accountId} failed: could not open chip or click delete`);
          return 'failed';
        } else {
          if (await this.openEventChipForDelete(view, eid)) {
            if (await this.clickDeleteControl(view)) {
              log.info(`Delete event on ${accountId} succeeded from the event on screen`);
              return 'ok';
            }
          }
          log.warn(
            `Delete event on ${accountId} failed: the event was on screen but its delete control could not be clicked`,
          );
          return 'failed';
        }
      } catch (err) {
        log.error(`Delete event on ${accountId} threw an error:`, err);
        return 'failed';
      } finally {
        if (routedToPath && previousPath) {
          const current = await this.currentPath(view);
          if (current && current.includes(routedToPath)) {
            void this.routeTo(view, previousPath).catch(() => {});
          }
        }
        release();
      }
    });
  }

  /**
   * Ticks a task off in Google Tasks, or ticks it back open, using CalendarActionDriver.
   */
  public async setTaskCompleted(
    _view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    startTime: Date,
    completed: boolean,
  ): Promise<'ok' | 'busy' | 'failed'> {
    log.info(`Marking a task ${completed ? 'complete' : 'open'} on ${accountId}`);
    return this.host.withActionLock(accountId, 'completeTask', async () => {
      if (!this.host.hasAccount(accountId)) {
        log.warn(`Cannot change the task: account ${accountId} not found`);
        return 'failed';
      }

      const woken = await this.host.wake(accountId, false);
      if (!woken) {
        log.warn(`Cannot change the task: no view available for ${accountId}`);
        return 'failed';
      }
      const { view, release } = woken;

      if (!(await this.waitForCalendarGrid(view, accountId))) {
        log.warn(`Calendar did not finish loading for ${accountId}; the task cannot be changed`);
        release();
        return 'failed';
      }

      if (await this.isBusyEditing(view)) {
        log.info(`Changing the task on ${accountId} held: view is busy editing`);
        release();
        return 'busy';
      }

      const previousPath = await this.currentPath(view);
      let routedToDay: string | null = null;
      try {
        if (!(await this.hasEventChip(view, eid))) {
          const day = this.pathForDate(previousPath, startTime, await this.currentViewMode(view));
          if (!(await this.routeTo(view, day))) {
            log.warn(`Changing the task on ${accountId} failed: could not route to day ${day}`);
            return 'failed';
          }
          routedToDay = day;
        }
        if (!(await this.clickEventChip(view, eid))) {
          log.warn(
            `Changing the task on ${accountId} failed: could not click the event chip (${decodeEid(eid)?.eventId ?? 'unresolved'})`,
          );
          return 'failed';
        }
        // The panel animates in; the control is not addressable on the next tick.
        if (!(await this.waitFor(view, COMPLETE_CONTROL))) {
          log.warn(`Changing the task on ${accountId} failed: the control never appeared`);
          return 'failed';
        }
        const clicked = await this.clickCompleteControl(view, completed);
        if (!clicked) {
          log.warn(`Changing the task on ${accountId} failed: confirmation not observed`);
          return 'failed';
        }
        log.info(`Marked the task ${completed ? 'complete' : 'open'} on ${accountId}`);
        return 'ok';
      } catch (err) {
        log.error(`Changing the task on ${accountId} threw an error:`, err);
        return 'failed';
      } finally {
        // Same restoration as an RSVP: completing a task from the menu bar is triage, not
        // a request to be taken to the day the task sits on.
        if (routedToDay && previousPath) {
          const current = await this.currentPath(view);
          if (current && current.includes(routedToDay)) {
            void this.routeTo(view, previousPath).catch(() => {});
          }
        }
        release();
      }
    });
  }

  /**
   * Puts the open task panel's completion button into `completed`, the way the delete
   * control is clicked.
   *
   * One button both ticks and unticks, and the attribute it is found by is also the
   * state it is in. So a task already in the wanted state is reported as done rather
   * than clicked: clicking it would move it the wrong way.
   */
  private async clickCompleteControl(view: WebContentsView, completed: boolean): Promise<boolean> {
    const wanted = completed ? 'true' : 'false';
    const current: string | null = await view.webContents
      .executeJavaScript(
        `document.querySelector(${JSON.stringify(COMPLETE_CONTROL)})?.dataset.completed ?? null`,
      )
      .catch(() => null);
    if (current === wanted) {
      log.info(`The task was already ${completed ? 'complete' : 'open'}`);
      return true;
    }

    const rect = await this.waitForRect(view, COMPLETE_CONTROL);
    if (!rect) {
      log.warn('Complete control never became visible');
      return false;
    }

    this.sendTrustedClick(view, rect.x, rect.y);

    // Google flips the attribute on the button it has just acted on, so the change is
    // confirmed by the same control rather than by the panel closing, which it does
    // not always do.
    const confirmed: boolean = await view.webContents
      .executeJavaScript(
        `
        ${DOM_DRIVE_PREAMBLE}
        waitUntil(() => {
          const button = document.querySelector(${JSON.stringify(COMPLETE_CONTROL)});
          return !button || button.dataset.completed === ${JSON.stringify(wanted)};
        }, { quietMs: 250, timeoutMs: 5000 });
      `,
      )
      .catch(() => false);

    if (!confirmed) {
      log.warn(`Calendar never confirmed the task was marked ${completed ? 'complete' : 'open'}`);
    }

    return Boolean(confirmed);
  }

  /**
   * Opens one event's detail panel and waits for its delete control.
   *
   * The RSVP twin of this, with a different control to wait for. Clicking the chip at a
   * point was measured to be the wrong move here for the same reason it is everywhere
   * else — see `clickEventChip` — and it is worst in this path: a coordinate that has
   * scrolled out from under the click does not fail, it deletes a different event.
   */
  private async openEventChipForDelete(view: WebContentsView, eid: string): Promise<boolean> {
    if (!(await this.openPanelFor(view, eid))) return false;
    return this.waitFor(view, DELETE_CONTROL);
  }

  /**
   * Whether the event's own panel is open, opening it from its chip when it is not.
   *
   * The panel carries the event's id, so it answers a chip lookup as well as the chip
   * does — and it sits over the chip it belongs to, where a click is refused for landing
   * on the panel instead. An event whose panel is already open is therefore acted on
   * through that panel, which is also the shorter path: its controls are the ones the
   * caller is about to look for.
   */
  private async openPanelFor(view: WebContentsView, eid: string): Promise<boolean> {
    if (await this.panelOpenFor(view, eid)) return true;
    return this.clickEventChip(view, eid);
  }

  /** Whether one of the event's own nodes is inside an open panel. */
  private async panelOpenFor(view: WebContentsView, eid: string): Promise<boolean> {
    const selector = chipSelector(eid);
    try {
      return await view.webContents.executeJavaScript(`
        [...document.querySelectorAll(${JSON.stringify(selector)})]
          .some((node) => node.closest('[role="dialog"]'))
      `);
    } catch {
      return false;
    }
  }

  /**
   * What the page was saying before a click, for the confirmation that follows it.
   *
   * The live region is where Calendar announces what it did, and the detail panel is the
   * `[role="dialog"]` an action closes. Both have to be read before the click: read after,
   * the panel has already gone and the region has already spoken, so there is nothing left
   * to compare against and a change that did happen reports failed.
   */
  private async pageConfirmationState(
    view: WebContentsView,
  ): Promise<{ announcement: string; dialogWasOpen: boolean } | null> {
    try {
      const state = await view.webContents.executeJavaScript(`
        (() => {
          const LIVE = '[role="status"], [role="alert"], [aria-live="polite"]';
          return {
            announcement: Array.from(document.querySelectorAll(LIVE)).map((el) => el.textContent || '').join('\\u0000'),
            dialogWasOpen: document.querySelector('[role="dialog"]') !== null,
          };
        })();
      `);
      return state && typeof state === 'object'
        ? (state as { announcement: string; dialogWasOpen: boolean })
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Answers the modal that asks how much of a recurring event an action covers.
   *
   * A whole event is not changed by the control the user pressed: Calendar raises this
   * modal first, and it is the OK rather than the original click that sends the change. A
   * caller that stops at the click has done nothing and has no way to tell, which is what
   * a reply on a recurring invitation did.
   *
   * The wait is what separates the two cases, so it has to outlast the modal appearing but
   * not the action: the modal is raised on the click, and by 800ms a page that was going to
   * raise one has.
   */
  private async confirmScopeDialog(view: WebContentsView): Promise<void> {
    await view.webContents
      .executeJavaScript(
        `
        ${DOM_DRIVE_PREAMBLE}
        (async () => {
          const instance = await waitUntil(
            () => document.querySelector(${JSON.stringify(SCOPE_INSTANCE_CONTROL)}),
            { quietMs: 0, timeoutMs: 800 },
          );
          // No modal by the time the page settled means the click was the whole action.
          if (!instance) return;
          // The dialog opens on the occurrence, but Google remembers the last answer, so
          // the narrower option is chosen rather than assumed.
          if (!instance.checked) instance.click();
          const okBtn = document.querySelector(${JSON.stringify(CONFIRM_SCOPE_CONTROL)});
          if (okBtn) okBtn.click();
        })();
      `,
      )
      .catch(() => {});
  }

  /** The control inside the open panel, clicked the way `clickRsvpControl` clicks its own. */
  private async clickDeleteControl(view: WebContentsView): Promise<boolean> {
    const rect = await this.waitForRect(view, DELETE_CONTROL);
    if (!rect) {
      log.warn('Delete control never became visible in the open event');
      return false;
    }

    // The "before" state is read before the click, not after: the click is what changes
    // the page. Read afterwards, the panel has already closed and the live region has
    // already spoken, so there is no open dialog left to close and no earlier
    // announcement for the new one to differ from; a delete that happened then reports
    // failed. Taken here, both signals survive however late the confirmation runs,
    // which is always after the recurring-modal wait below.
    const before = await this.pageConfirmationState(view);

    this.sendTrustedClick(view, rect.x, rect.y);

    await this.confirmScopeDialog(view);

    // Wait for evidence Calendar deleted it: the detail panel closing, or a live
    // region changing from what it held before the click. Both compare against the
    // snapshot taken before the click above; the panel has to have been open for its
    // absence to mean anything.
    let result: { ok: boolean; reason: string; elapsedMs: number } | boolean = {
      ok: false,
      reason: 'unhandled',
      elapsedMs: 0,
    };
    try {
      result = await view.webContents.executeJavaScript(`
        ${DOM_DRIVE_PREAMBLE}
        (async () => {
          const LIVE = '[role="status"], [role="alert"], [aria-live="polite"]';
          // Calendar parks "Loading..." in one of these and leaves it there, so a
          // non-empty check is true before anything has happened. What moves when
          // Calendar speaks is the combined text.
          const announcement = () =>
            Array.from(document.querySelectorAll(LIVE)).map((el) => el.textContent || '').join('\\u0000');

          const before = ${JSON.stringify(before)};
          const startTime = Date.now();

          const ok = await waitUntil(() => {
            // No snapshot means no evidence either way: report unconfirmed rather than
            // assume the delete landed.
            const spoke = before !== null && announcement() !== before.announcement;
            const dialogClosed =
              Boolean(before && before.dialogWasOpen) &&
              document.querySelector('[role="dialog"]') === null;
            return Boolean(spoke || dialogClosed);
          }, { quietMs: 250, timeoutMs: 5000 });

          return {
            ok: Boolean(ok),
            reason: ok ? 'settled' : 'predicate_timeout',
            elapsedMs: Date.now() - startTime,
          };
        })();
      `);
    } catch (err) {
      log.warn('Error waiting for delete confirmation:', err);
      result = { ok: false, reason: 'exception', elapsedMs: 0 };
    }

    const isOk =
      typeof result === 'object' && result !== null ? Boolean(result.ok) : Boolean(result);
    const reason =
      typeof result === 'object' && result !== null
        ? result.reason
        : isOk
          ? 'settled'
          : 'unconfirmed';
    const elapsedMs = typeof result === 'object' && result !== null ? result.elapsedMs : 0;

    if (!isOk) {
      log.warn(`Calendar never confirmed the deletion (${reason} after ${elapsedMs}ms)`);
      return false;
    }

    log.info(`Confirmed delete in ${elapsedMs}ms`);
    return true;
  }

  /** Whether the view currently holds an event chip for this eid without routing. */
  private async hasEventChip(view: WebContentsView, eid: string): Promise<boolean> {
    const selector = chipSelector(eid);
    try {
      return await view.webContents.executeJavaScript(`
        Boolean(document.querySelector(${JSON.stringify(selector)}))
      `);
    } catch {
      return false;
    }
  }

  /**
   * Whether the view holds work a route change would interrupt.
   *
   * Three things qualify: the editor route, the discard alert, and a dialog holding a
   * field the user can type into. The quick-create overlay is the reason for the last
   * one; it is a dialog rather than a route, and is just as unwelcome to navigate out
   * from under.
   *
   * An event's own detail popup is a `[role="dialog"]` too, and it is the one dialog
   * that must not count. Reveal opens it and waits for it, so a guard that treats every
   * dialog as unsaved work refuses every action taken while an event is on screen —
   * which is most of them, since the popover's delete and complete are pressed against
   * an event the user is looking at. Held actions then sit in `heldActions` until the
   * popup is closed by hand.
   *
   * Editable content is what separates the two, measured on a live account: the detail
   * popup for an event and for a task each hold no field at all, while quick-create
   * holds nine. `data-chips-dialog` looks like the tidier hook and is not one, because
   * Calendar puts it on quick-create as well.
   */
  private async isBusyEditing(view: WebContentsView): Promise<boolean> {
    try {
      return await view.webContents.executeJavaScript(`
        (() => {
          if (/\\/r\\/eventedit/.test(location.pathname)) return true;
          if (document.querySelector('[role="alertdialog"]')) return true;
          return Array.from(document.querySelectorAll('[role="dialog"]')).some(
            (d) => d.querySelector('input,textarea,[contenteditable="true"]') !== null,
          );
        })();
      `);
    } catch {
      // Unreadable means unknown, and acting on unknown is what this guard prevents.
      return true;
    }
  }

  /**
   * Changes route without reloading the document.
   *
   * `loadURL` would tear the page down — losing an open editor or Quick Add draft — for
   * the same reason Magimail routes Gmail by `location.hash` rather than loading a URL.
   * Gmail's hash has no equivalent here, because Calendar routes by path; but Calendar is
   * a single-page app whose router listens for `popstate`, so `pushState` followed by a
   * synthetic `popstate` is the same same-document trick by another route.
   *
   * Measured: the document object survives, `document.title` updates, and the new day's
   * chips render.
   */
  /**
   * Routes the view to a path and waits until Calendar has rendered it.
   *
   * Pushing state and returning is not enough, and the gap is wide enough to lose a
   * click in. Calendar keeps the outgoing view's nodes for about 270 ms after the
   * route, so a chip found in that window belongs to the render being torn down, and
   * clicking it does nothing: the event's own chip is drawn in the previous view too,
   * which is exactly when a link arrives for an account that was asleep.
   *
   * Arrival is the re-render finishing, watched with a `MutationObserver` and taken as
   * SETTLE_MS with nothing changed. A route that redraws nothing settles immediately
   * and costs only that wait, which matters because the commonest link of all is one
   * to today, landing on the day an account already resumes into.
   *
   * The page title was tried as the signal first, on the grounds that Magimail's
   * `routeToThread` waits for a title that has moved. It is wrong here: a link to
   * today routes `/calendar/u/<n>/r` to `/r/day/<today>`, which changes the path
   * without changing what is on screen, so the title never moves and every such route
   * reports failure.
   *
   * SETTLE_MS clears the gaps inside a transition rather than guessing. Measured
   * against live Calendar, a route redraws in bursts ending at 262 ms (week to day),
   * 254 ms (day to day) and 488 ms (month to day), with the longest gap *within* one
   * transition at 190 ms; an idle page mutates not at all.
   */
  private async routeTo(view: WebContentsView, path: string): Promise<boolean> {
    const wc = view.webContents;
    if (wc.isDestroyed()) return false;
    if (pathnameOf(wc.getURL()) === path) return true;

    try {
      const arrived = await wc.executeJavaScript(`
        ${DOM_DRIVE_PREAMBLE}
        (() => {
          history.pushState({}, '', ${JSON.stringify(path)});
          window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
          return waitUntil(() => true, { quietMs: 250, timeoutMs: 5000 });
        })();
      `);
      if (!arrived) log.warn(`Routed to ${path} but Calendar kept redrawing`);
      return Boolean(arrived);
    } catch {
      return false;
    }
  }

  private async currentPath(view: WebContentsView): Promise<string | null> {
    try {
      return await view.webContents.executeJavaScript('location.pathname + location.search');
    } catch {
      return null;
    }
  }

  /**
   * Opens one event's detail panel.
   *
   * Matched on `data-eventid`, which is base64 of `"<instanceId> <calendarId>"` and so
   * byte-identical to the `eid` the poller already decodes, bar the prefix a task's chip
   * carries; see `chipSelector`. Matching on `aria-label` looks tidier and is wrong:
   * event chips carry an empty one, and only the working-location chip is labelled, so a
   * label match silently opens the wrong thing.
   *
   * The chip is addressed as an element, not as a point; see `clickEventChip` for why
   * coordinates do not survive a scrolling grid.
   */
  private async openEventChip(view: WebContentsView, eid: string): Promise<boolean> {
    if (!(await this.openPanelFor(view, eid))) return false;
    // The panel animates in; the control is not addressable on the next tick.
    return this.waitFor(view, [
      domSelector('rsvpYes'),
      domSelector('rsvpNo'),
      domSelector('rsvpMaybe'),
    ]);
  }

  /**
   * Clicks an event's chip, reporting whether the chip was there at all.
   *
   * Finding the chip and the panel opening are separate failures with separate causes —
   * the wrong day versus a click Calendar ignored — so the caller is told which.
   */
  /**
   * Opens an event by clicking its chip.
   *
   * The click is a real input event, the same way an RSVP reply and a delete are sent.
   * `button.click()` is ignored: Calendar's chip handler acts on trusted input only,
   * so a synthetic click leaves the page exactly as it was, and the caller reports a
   * panel that never opened.
   *
   * Clicking a point rather than an element means the point has to be the right one.
   * Calendar draws an event as several nodes in a grid that scrolls independently, so
   * a chip's coordinates are routinely outside the viewport while the element itself
   * is perfectly addressable, and a click landing there opens whatever is drawn at
   * that spot instead. The chip is scrolled into view first, and a centre still
   * outside the viewport is refused rather than clicked.
   *
   * Where the role sits depends on the view, so all three positions are tried. In day
   * view the chip is a wrapper and the button is inside it; in week view the chip
   * carries `role="button"` itself.
   */
  private async clickEventChip(view: WebContentsView, eid: string): Promise<boolean> {
    const selector = chipSelector(eid);
    if (!(await this.waitFor(view, selector))) {
      const chips = await this.countChips(view);
      log.warn(`No chip matching the event in this view; ${chips} chip(s) rendered`);
      return false;
    }

    let point: { x: number; y: number } | null = null;
    try {
      point = await view.webContents.executeJavaScript(`
        new Promise((resolve) => {
          for (const chip of document.querySelectorAll(${JSON.stringify(selector)})) {
            const button = chip.matches('[role="button"]')
              ? chip
              : chip.querySelector('[role="button"]') ?? chip.closest('[role="button"]');
            if (!button) continue;

            button.scrollIntoView({ block: 'center', inline: 'nearest' });
            // A timer rather than requestAnimationFrame, which never fires in a view
            // that is not on screen: an account woken for a link is exactly that, and
            // a frame callback there leaves this promise pending for ever.
            setTimeout(() => {
              const rect = button.getBoundingClientRect();
              const x = Math.round(rect.left + rect.width / 2);
              const y = Math.round(rect.top + rect.height / 2);
              const onScreen =
                rect.width > 0 && rect.height > 0 &&
                x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;

              // What is actually drawn at that point. A rect inside the viewport is
              // not proof the chip is what a click there would reach: another chip,
              // an overlay or a popup can sit on top, and this event's own panel is
              // the one thing a click must never land on by accident.
              const hit = onScreen ? document.elementFromPoint(x, y) : null;
              const hitsChip = hit !== null && (button.contains(hit) || hit.contains(button));

              resolve(onScreen && hitsChip ? { x, y } : null);
            }, 50);
            return;
          }
          resolve(null);
        });
      `);
    } catch {
      return false;
    }

    if (!point) {
      log.warn('No event chip on screen to click');
      return false;
    }

    // A click into an unfocused view is spent focusing it and never reaches the page,
    // so the view has to be focused first or the chip swallows exactly the click that
    // matters. A view woken for a link is never focused, which is why this shows up
    // there and not when the same event is opened from a calendar already in use.
    view.webContents.focus();
    this.sendTrustedClick(view, point.x, point.y);
    return true;
  }

  /**
   * Waits until the view holds a Google Calendar page that has rendered its grid.
   *
   * A view woken for a link starts blank, and every step after this one succeeds
   * meaninglessly against a blank document: `pushState` sets a path nothing reads, and
   * the chip that never existed cannot be found. Waiting for a chip rather than for
   * `did-finish-load` is what proves the app booted, not merely that a document arrived.
   */
  private async waitForCalendar(view: WebContentsView): Promise<boolean> {
    if (!view.webContents.getURL().includes('/calendar/')) {
      const loaded = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 15_000);
        view.webContents.once('did-finish-load', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!loaded) return false;
    }
    return this.waitFor(view, ['[data-eventid]', '[role="grid"]']);
  }

  /**
   * Waits for the calendar grid, leaving full-screen Tasks first when it has to.
   *
   * The grid-dependent actions — reveal, RSVP, delete, complete — have nothing to drive
   * on the Tasks canvas: no chip, no RSVP control, no Create button. Their wait for a
   * grid would otherwise time out against a page that never draws one, so the view is
   * routed back to the calendar root and only then awaited.
   */
  private async waitForCalendarGrid(view: WebContentsView, accountId: string): Promise<boolean> {
    if (!(await this.host.waitForPage(view))) return false;
    if (!(await this.leaveTasksIfNeeded(view, accountId))) return false;
    return this.waitForCalendar(view);
  }

  /**
   * Routes a view out of full-screen Tasks, when it is in it.
   *
   * Returns whether the view is out afterwards, so a caller can tell a route that was
   * not needed from one that failed. The destination is the calendar root, whose view is
   * the user's own default (day, week or month); a caller with somewhere more specific
   * to be routes there next from the root.
   *
   * A task being written is not flushed first: Tasks persists an uncommitted draft as it
   * is typed, measured on a live account, so leaving the mode does not lose it.
   */
  private async leaveTasksIfNeeded(view: WebContentsView, accountId: string): Promise<boolean> {
    // Read the route from the view's own URL rather than the page: it is ground truth even
    // when the navigation observer has not fired yet, and it costs no round trip into a
    // document this is about to replace.
    const currentPath = pathnameOf(view.webContents.getURL());
    if (viewModeForPath(currentPath) !== 'tasks') return true;

    const path = calendarRoot(currentPath);
    log.info(`Account ${accountId} is in the Tasks view; leaving for ${path}`);
    return this.routeTo(view, path);
  }
  private async countChips(view: WebContentsView): Promise<number> {
    try {
      return await view.webContents.executeJavaScript(
        'document.querySelectorAll("[data-eventid]").length',
      );
    } catch {
      return -1;
    }
  }

  private async clickRsvpControl(
    view: WebContentsView,
    response: 'yes' | 'no' | 'maybe',
  ): Promise<boolean> {
    // The response controls are authored ids (`#xRsvpYesBu`, `#xRsvpNoBu`,
    // `#xRsvpMaybeBu`) that only render on an invitation; see `docs/magical/actions.md`.
    const actionName = response === 'yes' ? 'rsvpYes' : response === 'no' ? 'rsvpNo' : 'rsvpMaybe';
    const selector = domSelector(actionName);
    const rect = await this.waitForRect(view, selector);
    if (!rect) {
      log.warn(`RSVP ${actionName} control (${selector}) never became visible in the open event`);
      return false;
    }

    // Read before the click, for the same reason the delete path reads it there: the
    // scope modal below is answered afterwards, and by then the panel it is compared
    // against has already moved on.
    const before = await this.pageConfirmationState(view);

    this.sendTrustedClick(view, rect.x, rect.y);

    // A recurring invitation is not answered by that click. Calendar raises the "RSVP to
    // recurring event" modal first, and its OK is what sends the change, so a caller that
    // stops at the click has sent nothing and has no way to tell.
    await this.confirmScopeDialog(view);

    // Wait for evidence Calendar took the response: the three controls disappear, the
    // panel closes, or something is announced that was not being announced before.
    // Uses waitUntil from core with quietMs so slow renderers do not cause false failures.
    let result: { ok: boolean; reason: string; elapsedMs: number } | boolean = {
      ok: false,
      reason: 'unhandled',
      elapsedMs: 0,
    };
    try {
      result = await view.webContents.executeJavaScript(`
        ${DOM_DRIVE_PREAMBLE}
        (async () => {
          const LIVE = '[role="status"], [role="alert"], [aria-live="polite"]';
          // Calendar parks the text "Loading..." in the first of these and leaves it
          // there, so a non-empty check is true before anything has happened. What
          // moves when Calendar speaks is the combined text.
          const announcement = () =>
            Array.from(document.querySelectorAll(LIVE)).map((el) => el.textContent || '').join('\\u0000');

          const before = ${JSON.stringify(before)};
          const startTime = Date.now();

          const ok = await waitUntil(() => {
            const btn = document.querySelector(${JSON.stringify(selector)});
            // A successful response takes all three controls out of the panel, so their
            // absence is the signal. aria-checked and aria-selected are kept in case
            // Calendar ever reports the state there.
            const controlGone = btn === null;
            const isSelected = btn && (
              btn.getAttribute('aria-checked') === 'true' ||
              btn.getAttribute('aria-selected') === 'true'
            );
            const spoke = before !== null && announcement() !== before.announcement;
            const dialogClosed =
              Boolean(before && before.dialogWasOpen) &&
              document.querySelector('[role="dialog"]') === null;
            return Boolean(controlGone || isSelected || spoke || dialogClosed);
          }, { quietMs: 250, timeoutMs: 5000 });

          return {
            ok: Boolean(ok),
            reason: ok ? 'settled' : 'predicate_timeout',
            elapsedMs: Date.now() - startTime,
          };
        })();
      `);
    } catch (err) {
      log.warn('Error waiting for RSVP confirmation:', err);
      result = { ok: false, reason: 'exception', elapsedMs: 0 };
    }

    const isOk =
      typeof result === 'object' && result !== null ? Boolean(result.ok) : Boolean(result);
    const reason =
      typeof result === 'object' && result !== null
        ? result.reason
        : isOk
          ? 'settled'
          : 'unconfirmed';
    const elapsedMs = typeof result === 'object' && result !== null ? result.elapsedMs : 0;

    if (!isOk) {
      log.warn(
        `Calendar never confirmed the ${response} response (${reason} after ${elapsedMs}ms)`,
      );
      return false;
    }

    log.info(`Confirmed ${response} response in ${elapsedMs}ms`);
    return true;
  }

  /** A real input event, which is what Calendar's own handlers require. */
  private sendTrustedClick(view: WebContentsView, x: number, y: number): void {
    const wc = view.webContents;
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  /**
   * Polls for a selector's centre point, since Calendar renders asynchronously.
   *
   * Takes an ordered list as well as a single selector, so two ways of naming the
   * same control fall through in the order written rather than by document order.
   */
  private async waitForRect(
    view: WebContentsView,
    selector: string | string[],
    timeoutMs = 5000,
  ): Promise<{ x: number; y: number } | null> {
    const selectors = Array.isArray(selector) ? selector : [selector];
    const script = `
      ${DOM_DRIVE_PREAMBLE}
      (async () => {
        const el = await waitUntil(() => {
          const node = resolveOrdered(${JSON.stringify(selectors)});
          const r = node && node.getBoundingClientRect();
          if (r && r.width > 0 && r.height > 0) {
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          return null;
        }, { quietMs: 0, timeoutMs: ${timeoutMs} });
        return el || null;
      })()
    `;
    try {
      return await view.webContents.executeJavaScript(script);
    } catch {
      return null;
    }
  }

  private async waitFor(view: WebContentsView, selector: string | string[]): Promise<boolean> {
    return (await this.waitForRect(view, selector)) !== null;
  }

  public async triggerCalendarAction(
    action: 'createEvent' | 'createTask' | 'navPrev' | 'navToday' | 'navNext' | 'search',
    targetAccountId?: string,
  ): Promise<boolean> {
    const accountId = targetAccountId || this.host.activeAccountId();
    log.info(`Triggering calendar action ${action} on ${accountId}`);
    const woken = await this.host.wake(accountId);
    if (!woken) {
      log.warn(`Triggering calendar action ${action} failed: no view available for ${accountId}`);
      return false;
    }
    const { view, release } = woken;
    view.webContents.focus();

    const script = `
      ${DOM_DRIVE_PREAMBLE}
      (async () => {
        const action = ${JSON.stringify(action)};
        // The map actions are embedded whole, the way the preamble embeds the resolver;
        // the page has no module state to read the map from.
        const ACTIONS = ${JSON.stringify(TRIGGER_ACTIONS)};
        const click = (el) => {
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          el.click();
        };
        const resolve = (a) => findAction(document, a);

        if (action === 'createEvent' || action === 'createTask') {
          const menuItem = action === 'createTask' ? ACTIONS.createTask : ACTIONS.createEvent;
          const create = resolve(ACTIONS.create);
          if (create.el) {
            click(create.el);

            // The Event or Task item is a child of the click, so wait for it rather
            // than guessing a delay and leaving the menu open.
            const item = await waitUntil(() => {
              const r = resolve(menuItem);
              return r.el || null;
            }, { quietMs: 250, timeoutMs: 5000, label: 'create-menu' });
            if (item) {
              click(item);
            }

            return true;
          }
          return false;
        }

        if (action === 'search') {
          // 1. A shown search field is focused directly.
          const input = resolve(ACTIONS.searchInput);
          if (input.el) {
            input.el.focus();
            input.el.select();
            return true;
          }

          // 2. Otherwise the Search button expands the bar. The field is a child of
          //    the click, so wait for it rather than polling a fixed number of times.
          const button = resolve(ACTIONS.searchButton);
          if (button.el) {
            click(button.el);
            const field = await waitUntil(() => {
              const r = resolve(ACTIONS.searchInput);
              return r.el || null;
            }, { quietMs: 0, timeoutMs: 5000, label: 'search-input' });
            if (field) {
              field.focus();
              field.select();
            }

            return true;
          }

          // 3. Fallback: dispatch Google Calendar native shortcut '/' to open search
          const slashEvent = new KeyboardEvent('keydown', {
            key: '/',
            code: 'Slash',
            keyCode: 191,
            which: 191,
            bubbles: true,
            cancelable: true,
          });
          document.dispatchEvent(slashEvent);
          return true;
        }

        if (action === 'navToday' || action === 'navPrev' || action === 'navNext') {
          // 1. Dismiss an open event dialog so navigation is not left behind it.
          const close = resolve(ACTIONS.closeEventDialog);
          if (close.el) {
            click(close.el);
            if (action !== 'navToday') return 'dismissed-dialog';
          }

          // 2. In search view or the full editor, Back returns to the calendar.
          const back = resolve(ACTIONS.back);
          if (back.el) {
            click(back.el);
            // For Today, Back returns to the calendar where the Today control is
            // rendered by the navigation that follows; wait for it rather than
            // guessing a delay for it.
            if (action === 'navToday') {
              const today = await waitUntil(() => {
                const r = resolve(ACTIONS.today);
                return r.el || null;
              }, { quietMs: 250, timeoutMs: 5000, label: 'today-after-back' });
              if (today) click(today);
            }
            return 'went-back';
          }

          // 3. The normal navigation buttons. Resolved immediately before each click,
          // and clicked again until it takes: Calendar replaces the button when the period
          // changes, so a node still attached after a click means that click was ignored.
          // A wheel that spins freely produces several bursts and so gets several clicks,
          // which is why it appears to work where one click per swipe does not.
          const describe = (el) =>
            el
              ? el.tagName.toLowerCase() +
                (el.id ? '#' + el.id : '') +
                (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : '')
              : 'none';
          const pressed = () =>
            resolve(
              action === 'navToday' ? ACTIONS.today : action === 'navPrev' ? ACTIONS.navPrev : ACTIONS.navNext
            );

          let clicks = 0;
          let target = pressed();
          while (target.el && clicks < 4) {
            const node = target.el;
            const before = location.href;
            click(node);
            clicks += 1;
            const taken = await waitUntil(() => !node.isConnected || location.href !== before, {
              quietMs: 0,
              timeoutMs: 300,
              label: 'period-change',
            });
            if (taken) break;
            target = pressed();
          }
          if (clicks > 0) return 'moved-period ' + describe(target.el) + ' in ' + clicks + ' click(s)';

          return false;
        }

        return false;
      })();
    `;

    try {
      // Creating an event drives the Create button, which lives on the calendar toolbar
      // and not on the Tasks canvas. Leave Tasks first so the control the script looks
      // for is there to find, and so the user lands in the grid they asked for.
      if (action === 'createEvent' && !(await this.leaveTasksIfNeeded(view, accountId))) {
        log.warn(`Calendar action ${action} on ${accountId} could not leave the Tasks view`);
        return false;
      }

      try {
        const clicked = await view.webContents.executeJavaScript(script);
        if (clicked) {
          // The scripts report which branch answered, so a gesture that dispatches and
          // changes nothing says which of the three it took.
          const branch = typeof clicked === 'string' ? ` (${clicked})` : '';
          log.info(`Calendar action ${action} on ${accountId} dispatched via DOM${branch}`);
          return true;
        }
      } catch {
        // Fall through to URL check
      }

      // If DOM button was not found, check if we are in search, eventedit, settings, or trash view.
      // Navigating back to CALENDAR_APP_URL restores the main calendar view at Today.
      if (action === 'navToday' || action === 'navPrev' || action === 'navNext') {
        const currentUrl = view.webContents.getURL();
        if (
          currentUrl.includes('/search') ||
          currentUrl.includes('/eventedit') ||
          currentUrl.includes('/settings') ||
          currentUrl.includes('/trash')
        ) {
          log.info(`Calendar action ${action} on ${accountId} restoring root view via URL`);
          view.webContents.loadURL(CALENDAR_APP_URL);
          return true;
        }
      }

      // Creating an event used to fall back to loading the editor's URL, which
      // reported success on a view that had not attached and had no renderer:
      // nothing opened and nothing said so. The script above either clicks Create
      // or this is a genuine miss.
      log.warn(`Calendar action ${action} on ${accountId} could not be dispatched`);
      return false;
    } finally {
      release();
    }
  }

  /**
   * Creates a task, from whichever mode the account is in.
   *
   * Calendar mode stays in the grid: the Create menu carries a Task item, so the task is
   * written where the user is looking rather than routing them to `/r/tasks`. Tasks mode
   * draws no Create menu, so the entry the page does draw is clicked and focused instead.
   * Neither path moves the view, which is what separates this from `createEvent`, whose
   * control exists only on the grid and so has to leave Tasks before it looks for it.
   */
  public async triggerNewTask(targetAccountId?: string): Promise<boolean> {
    const accountId = targetAccountId || this.host.activeAccountId();
    const existing = this.host.viewFor(accountId);
    const mode = viewIsAlive(existing)
      ? viewModeForPath(pathnameOf(existing!.webContents.getURL()))
      : this.host.viewMode(accountId);
    if (mode !== 'tasks') {
      return this.triggerCalendarAction('createTask', accountId);
    }

    log.info(`Triggering new task on ${accountId} in the Tasks view`);
    const woken = await this.host.wake(accountId);
    if (!woken) {
      log.warn(`Triggering new task failed: no view available for ${accountId}`);
      return false;
    }
    const { view, release } = woken;
    try {
      view.webContents.focus();
      const focused = await this.focusTaskEntry(view);
      if (focused) log.info(`Focused the task entry on ${accountId}`);
      else log.warn(`Could not focus the task entry on ${accountId}`);
      return focused;
    } finally {
      release();
    }
  }

  /**
   * Focuses Google Tasks' own "Add a task" entry in the full-screen Tasks view.
   *
   * The full-page Tasks canvas is the `tasks.google.com/embed/fullscreen/` iframe, not
   * Calendar's own document, so the script runs in that frame. The button sits under the
   * `data-shown-add-task-btn` container its list renders, and clicking it reveals the
   * entry, whose `aria-label` is "Task title"; both were measured on a live account. The
   * iframe lags the route that swaps the mode in, and the label sits on the field's wrapper
   * as well as the field, so the button is waited for and the match is descended into for
   * the editable element rather than asserted unique or assumed to be the field itself.
   */
  private async focusTaskEntry(view: WebContentsView): Promise<boolean> {
    const script = `
      ${DOM_DRIVE_PREAMBLE}
      (async () => {
        const ACTIONS = ${JSON.stringify(TRIGGER_ACTIONS)};
        const resolve = (a) => findAction(document, a);
        // "Task title" labels the editable field's wrapper as well as the field, and the
        // wrapper comes first in document order, so a match that is not itself editable is
        // descended into rather than dismissed.
        const asField = (el) => {
          if (!el) return null;
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return el;
          return el.querySelector('input, textarea, [contenteditable="true"]');
        };

        const existing = asField(resolve(ACTIONS.addTaskField).el);
        if (existing) {
          existing.focus();
          existing.select?.();
          return 'focused-entry';
        }

        // The iframe lags the mode switch, so the button is waited for rather than
        // resolved once against a document that is still loading.
        const button = await waitUntil(() => {
          const r = resolve(ACTIONS.addTaskButton);
          return r.el || null;
        }, { quietMs: 250, timeoutMs: 10000, label: 'add-task-button' });
        if (!button) return false;
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        button.click();

        const field = await waitUntil(() => {
          return asField(resolve(ACTIONS.addTaskField).el);
        }, { quietMs: 250, timeoutMs: 5000, label: 'task-entry' });
        if (!field) return false;
        field.focus();
        field.select?.();
        return 'revealed-entry';
      })();
    `;

    const target = this.tasksFrame(view) ?? view.webContents.mainFrame;
    if (!target || target.isDestroyed()) return false;
    try {
      return Boolean(await target.executeJavaScript(script));
    } catch {
      return false;
    }
  }

  /**
   * The `tasks.google.com` frame inside a view, if it holds one.
   *
   * Full-screen Tasks embeds the Tasks app rather than rendering it, so the entry it
   * draws is unreachable from the top frame. The same walk backs `injectSubframeCss`.
   */
  private tasksFrame(view: WebContentsView): WebFrameMain | undefined {
    const root = view.webContents.mainFrame;
    if (!root) return undefined;
    const walk = (frame: WebFrameMain): WebFrameMain | undefined => {
      if (frame.isDestroyed()) return undefined;
      if (frame.url.startsWith('https://tasks.google.com/')) return frame;
      for (const child of frame.frames) {
        const found = walk(child);
        if (found) return found;
      }
      return undefined;
    };
    return walk(root);
  }
}
