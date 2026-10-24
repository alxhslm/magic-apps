import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FindInPageController, getFindInPageHtml } from '../src/find-in-page.js';
import type { UiTranslator } from '../src/ui-strings.js';

/** Returns the key, so a test can see which catalogue entries the view asks for. */
const t: UiTranslator = (key) => key;

type TestListener = (...args: unknown[]) => void;

interface MockView {
  webContents: {
    isDestroyed: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    executeJavaScript: ReturnType<typeof vi.fn>;
    _trigger: (event: string, ...args: unknown[]) => void;
  };
  setBounds: ReturnType<typeof vi.fn>;
  setBackgroundColor: ReturnType<typeof vi.fn>;
  _domReadyCb?: () => void;
}

let mockViewInstances: MockView[] = [];

vi.mock('electron', () => {
  return {
    TOOLBAR_HEIGHT: 52,
    BaseWindow: vi.fn(),
    WebContentsView: vi.fn().mockImplementation(function (this: MockView) {
      const viewListeners: Record<string, TestListener[]> = {};
      this.webContents = {
        isDestroyed: vi.fn().mockReturnValue(false),
        loadURL: vi.fn(),
        close: vi.fn(),
        focus: vi.fn(),
        once: vi.fn((event: string, cb: () => void) => {
          if (event === 'dom-ready') {
            this._domReadyCb = cb;
          }
        }),
        on: vi.fn((event: string, handler: TestListener) => {
          viewListeners[event] = viewListeners[event] || [];
          viewListeners[event].push(handler);
        }),
        executeJavaScript: vi.fn().mockResolvedValue(undefined),
        _trigger: (event: string, ...args: unknown[]) => {
          if (viewListeners[event]) {
            viewListeners[event].forEach((h) => h(...args));
          }
        },
      };
      this.setBounds = vi.fn();
      this.setBackgroundColor = vi.fn();
      mockViewInstances.push(this);
    }),
  };
});

interface MockWebContents {
  isDestroyed: ReturnType<typeof vi.fn>;
  findInPage: ReturnType<typeof vi.fn>;
  stopFindInPage: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  _trigger: (event: string, ...args: unknown[]) => void;
}

interface MockWindow {
  isDestroyed: ReturnType<typeof vi.fn>;
  getContentBounds: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  _trigger: (event: string, ...args: unknown[]) => void;
  contentView: {
    children: unknown[];
    addChildView: ReturnType<typeof vi.fn>;
    removeChildView: ReturnType<typeof vi.fn>;
  };
}

describe('FindInPageController', () => {
  let mockWindow: MockWindow;
  let mockTargetWebContents: MockWebContents;
  let getTarget: () => MockWebContents;
  let controller: FindInPageController;

  beforeEach(() => {
    mockViewInstances = [];

    const listeners: Record<string, TestListener[]> = {};

    mockTargetWebContents = {
      isDestroyed: vi.fn().mockReturnValue(false),
      findInPage: vi.fn().mockReturnValue(1),
      stopFindInPage: vi.fn(),
      focus: vi.fn(),
      on: vi.fn((event: string, handler: TestListener) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(handler);
      }),
      removeListener: vi.fn((event: string, handler: TestListener) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((h) => h !== handler);
        }
      }),
      _trigger: (event: string, ...args: unknown[]) => {
        if (listeners[event]) {
          listeners[event].forEach((h) => h(...args));
        }
      },
    };
    getTarget = () => mockTargetWebContents;

    const windowListeners: Record<string, TestListener[]> = {};

    mockWindow = {
      isDestroyed: vi.fn().mockReturnValue(false),
      getContentBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1400, height: 900 }),
      on: vi.fn((event: string, handler: TestListener) => {
        windowListeners[event] = windowListeners[event] || [];
        windowListeners[event].push(handler);
      }),
      removeListener: vi.fn((event: string, handler: TestListener) => {
        if (windowListeners[event]) {
          windowListeners[event] = windowListeners[event].filter((h) => h !== handler);
        }
      }),
      _trigger: (event: string, ...args: unknown[]) => {
        if (windowListeners[event]) {
          windowListeners[event].forEach((h) => h(...args));
        }
      },
      contentView: {
        children: [],
        addChildView: vi.fn(function (view: unknown) {
          mockWindow.contentView.children.push(view);
        }),
        removeChildView: vi.fn(function (view: unknown) {
          const idx = mockWindow.contentView.children.indexOf(view);
          if (idx !== -1) mockWindow.contentView.children.splice(idx, 1);
        }),
      },
    };

    controller = new FindInPageController(
      mockWindow as unknown as import('electron').BaseWindow,
      getTarget as unknown as () => import('electron').WebContents | null,
      t,
    );
  });

  it('renders valid find in page HTML with input and controls', () => {
    const html = getFindInPageHtml(t);
    expect(html).toContain('find-input');
    expect(html).toContain('find-counter');
    expect(html).toContain('btn-prev');
    expect(html).toContain('btn-next');
    expect(html).toContain('btn-close');
  });

  it('asks the catalogue for the labels the view renders', () => {
    const html = getFindInPageHtml(t);
    expect(html).toContain('placeholder="find.placeholder"');
    expect(html).toContain('title="find.previous"');
    expect(html).toContain('title="find.next"');
    expect(html).toContain('title="find.close"');
    expect(html).toContain('"find.counter"');
  });

  it('is initially hidden', () => {
    expect(controller.isVisible()).toBe(false);
    expect(mockWindow.contentView.children.length).toBe(0);
  });

  it('shows and attaches the view when show() is called', () => {
    controller.show();
    expect(controller.isVisible()).toBe(true);
    expect(mockWindow.contentView.children.length).toBe(1);
    const view = mockViewInstances[0];
    expect(view.setBackgroundColor).toHaveBeenCalledWith('rgba(0, 0, 0, 0)');
    expect(view.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 330,
        height: 44,
        y: 58,
      }),
    );
  });

  it('toggles visibility correctly', () => {
    controller.toggle();
    expect(controller.isVisible()).toBe(true);
    controller.toggle();
    expect(controller.isVisible()).toBe(false);
    expect(mockWindow.contentView.children.length).toBe(0);
  });

  it('stops findInPage and restores focus on hide()', () => {
    controller.show();
    controller.hide();
    expect(mockTargetWebContents.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(mockTargetWebContents.focus).toHaveBeenCalled();
    expect(controller.isVisible()).toBe(false);
  });

  it('hides when close event is received from view', () => {
    controller.show();
    expect(controller.isVisible()).toBe(true);
    const view = mockViewInstances[0];
    view.webContents._trigger(
      'page-title-updated',
      { preventDefault: vi.fn() },
      JSON.stringify({ type: 'close' }),
    );
    expect(controller.isVisible()).toBe(false);
    expect(mockTargetWebContents.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });

  it('forwards query to target webContents', () => {
    controller.show();
    const view = mockViewInstances[0];
    view.webContents._trigger(
      'page-title-updated',
      { preventDefault: vi.fn() },
      JSON.stringify({ type: 'query', query: 'needle' }),
    );

    expect(mockTargetWebContents.findInPage).toHaveBeenCalledWith('needle', {
      forward: true,
    });
  });

  it('clears selection when query is cleared', () => {
    controller.show();
    const view = mockViewInstances[0];
    view.webContents._trigger(
      'page-title-updated',
      { preventDefault: vi.fn() },
      JSON.stringify({ type: 'query', query: 'needle' }),
    );
    view.webContents._trigger(
      'page-title-updated',
      { preventDefault: vi.fn() },
      JSON.stringify({ type: 'query', query: '' }),
    );

    expect(mockTargetWebContents.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(view.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('window.__setMatches(0, 0, true)'),
    );
  });

  it('advances next and previous', () => {
    controller.show();
    const view = mockViewInstances[0];
    view.webContents._trigger(
      'page-title-updated',
      { preventDefault: vi.fn() },
      JSON.stringify({ type: 'query', query: 'needle' }),
    );

    controller.findNext();
    expect(mockTargetWebContents.findInPage).toHaveBeenCalledWith('needle', {
      forward: true,
      findNext: true,
    });

    controller.findPrevious();
    expect(mockTargetWebContents.findInPage).toHaveBeenCalledWith('needle', {
      forward: false,
      findNext: true,
    });
  });

  it('updates match counter from target found-in-page event', () => {
    controller.show();
    const view = mockViewInstances[0];
    view.webContents._trigger(
      'page-title-updated',
      { preventDefault: vi.fn() },
      JSON.stringify({ type: 'query', query: 'needle' }),
    );

    mockTargetWebContents._trigger(
      'found-in-page',
      {},
      {
        requestId: 1,
        activeMatchOrdinal: 2,
        matches: 5,
      },
    );

    expect(view.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('window.__setMatches(2, 5, false)'),
    );
  });

  it('updates position when window resizes', () => {
    controller.show();
    const view = mockViewInstances[0];
    view.setBounds.mockClear();

    mockWindow.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 1400, height: 900 });
    mockWindow._trigger('resize');

    expect(view.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 1400 - 330 - 16,
        y: 58,
        width: 330,
        height: 44,
      }),
    );
  });

  it('handles target switching cleanly', () => {
    controller.show();
    const oldTarget = mockTargetWebContents;
    const newListeners: Record<string, TestListener[]> = {};
    const newTarget = {
      isDestroyed: vi.fn().mockReturnValue(false),
      findInPage: vi.fn(),
      stopFindInPage: vi.fn(),
      focus: vi.fn(),
      on: vi.fn((event: string, handler: TestListener) => {
        newListeners[event] = newListeners[event] || [];
        newListeners[event].push(handler);
      }),
      removeListener: vi.fn(),
    };

    const view = mockViewInstances[0];
    view.webContents._trigger(
      'page-title-updated',
      { preventDefault: vi.fn() },
      JSON.stringify({ type: 'query', query: 'test' }),
    );

    controller.updateTarget(newTarget as unknown as import('electron').WebContents);
    expect(oldTarget.removeListener).toHaveBeenCalled();
    expect(oldTarget.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(newTarget.findInPage).toHaveBeenCalledWith('test', {
      forward: true,
    });
  });

  it('suppresses target input events while find input is focused', () => {
    controller.show();
    const preventDefault = vi.fn();
    mockTargetWebContents._trigger(
      'before-input-event',
      { preventDefault },
      { type: 'keyDown', key: 'e' },
    );
    expect(preventDefault).toHaveBeenCalled();

    const view = mockViewInstances[0];
    expect(view.webContents.focus).toHaveBeenCalled();
  });

  it('allows target input events after blur and closes on Escape', () => {
    controller.show();
    const view = mockViewInstances[0];

    // Simulate input blur
    view.webContents._trigger(
      'page-title-updated',
      { preventDefault: vi.fn() },
      JSON.stringify({ type: 'blur' }),
    );

    const normalPreventDefault = vi.fn();
    mockTargetWebContents._trigger(
      'before-input-event',
      { preventDefault: normalPreventDefault },
      { type: 'keyDown', key: 'e' },
    );
    expect(normalPreventDefault).not.toHaveBeenCalled();

    // Escape closes the find bar
    const escapePreventDefault = vi.fn();
    mockTargetWebContents._trigger(
      'before-input-event',
      { preventDefault: escapePreventDefault },
      { type: 'keyDown', key: 'Escape' },
    );
    expect(escapePreventDefault).toHaveBeenCalled();
    expect(controller.isVisible()).toBe(false);
  });

  it('destroys all resources on destroy()', () => {
    controller.show();
    const view = mockViewInstances[0];

    controller.destroy();
    expect(mockWindow.removeListener).toHaveBeenCalled();
    expect(mockTargetWebContents.removeListener).toHaveBeenCalled();
    expect(view.webContents.close).toHaveBeenCalled();
  });
});
