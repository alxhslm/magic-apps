import { validateDomActionMap, type DomAction, type DomActionMap } from '@magimail/core';
import rawMap from '../dom-labels.json';

/**
 * The locale-aware action map Gmail is driven through.
 *
 * The data is `apps/magimail/dom-labels.json`; this module only validates it and
 * hands it out. `docs/shared/dom-labels.md` defines the shape and
 * `validateDomActionMap` is the runtime authority, so a problem in the file is a
 * defect thrown at load rather than a control that quietly stopped matching on a
 * non-English account.
 */
const problems = validateDomActionMap(rawMap);
if (problems.length > 0) {
  throw new Error(`apps/magimail/dom-labels.json is invalid:\n${problems.join('\n')}`);
}

export const DOM_ACTION_MAP: DomActionMap = rawMap as DomActionMap;

/** The named action. The key is checked here so a typo fails at startup, not at a click. */
export function domAction(name: string): DomAction {
  const action = DOM_ACTION_MAP.actions[name];
  if (!action) {
    throw new Error(`Unknown DOM action: ${name}`);
  }
  return action;
}

/** The single strong-hook selector for a hook action, for the few places that need it as text. */
export function domSelector(name: string): string {
  const selectors = domAction(name).selectors;
  if (!selectors || selectors.length === 0) {
    throw new Error(`DOM action "${name}" is not a hook action`);
  }
  return selectors[0];
}
