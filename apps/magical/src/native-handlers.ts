import { createNativeHandlerRegistry } from '@magimail/core';
import { loadAddon } from './native-addon.js';

const registry = createNativeHandlerRegistry(() => loadAddon().hasApplicationForUrl);

export const hasApplicationForUrl = registry.hasApplicationForUrl;
export const clearHandlerCache = registry.clearHandlerCache;
