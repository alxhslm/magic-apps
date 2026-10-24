import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dialog } from 'electron';

const settings = { askAboutDefaultCalendarApp: true };
const saved: Record<string, unknown> = {};

const helper = {
  available: true,
  report: {
    canClaim: true,
    handlers: [{ target: 'ics', label: 'Calendar files (.ics)', handler: '', isMagical: false }],
  } as unknown,
};

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() },
}));

vi.mock('../src/settings-store.js', () => ({
  loadSettings: () => ({ ...settings }),
  saveSetting: (key: string, value: unknown) => {
    saved[key] = value;
  },
}));

const sendToHelper = vi.fn(async (method: string) =>
  method === 'defaults.query' ? helper.report : { ok: true },
);

vi.mock('../src/swift-helper.js', () => ({
  isHelperAvailable: () => helper.available,
  sendToHelper: (method: string, params?: unknown) => sendToHelper(method, params as never),
}));

const { offerToBecomeDefault, claimDefault, promptSetAsDefault } =
  await import('../src/default-client.js');

function handlers(rows: { handler: string; isMagical: boolean }[], canClaim = true) {
  helper.report = {
    canClaim,
    handlers: rows.map((r) => ({ target: 'ics', label: 'Calendar files (.ics)', ...r })),
  };
}

describe('offerToBecomeDefault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.askAboutDefaultCalendarApp = true;
    helper.available = true;
    handlers([{ handler: 'Fantastical', isMagical: false }]);
    for (const key of Object.keys(saved)) delete saved[key];
  });

  it('offers when another app holds the type', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });

    await offerToBecomeDefault(null);

    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(sendToHelper).toHaveBeenCalledWith('defaults.claim', { target: 'ics' });
  });

  it('names the app that currently holds the type', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });

    await offerToBecomeDefault(null);

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [{ detail: string }];
    expect(options.detail).toContain('Fantastical');
  });

  it('says nothing when Magical already holds the type', async () => {
    handlers([{ handler: 'Magical', isMagical: true }]);

    await offerToBecomeDefault(null);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('says nothing once the user has asked not to be asked', async () => {
    settings.askAboutDefaultCalendarApp = false;

    await offerToBecomeDefault(null);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    // Not even a query: the answer could not change what happens next.
    expect(sendToHelper).not.toHaveBeenCalled();
  });

  it('says nothing when there is no bundle to register', async () => {
    handlers([{ handler: 'Fantastical', isMagical: false }], false);

    await offerToBecomeDefault(null);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('says nothing when the helper is absent, as under dev', async () => {
    helper.available = false;

    await offerToBecomeDefault(null);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('stops asking when the user picks Don’t Ask Again', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 2, checkboxChecked: false });

    await offerToBecomeDefault(null);

    expect(saved.askAboutDefaultCalendarApp).toBe(false);
    expect(sendToHelper).not.toHaveBeenCalledWith('defaults.claim', expect.anything());
  });

  it('leaves the question open when the user picks Not Now', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });

    await offerToBecomeDefault(null);

    expect(saved.askAboutDefaultCalendarApp).toBeUndefined();
    expect(sendToHelper).not.toHaveBeenCalledWith('defaults.claim', expect.anything());
  });
});

/**
 * The menu item, which differs from the launch prompt in one way that matters: it always
 * answers. The user chose it deliberately, so a silent no-op reads as a broken menu.
 */
describe('promptSetAsDefault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    helper.available = true;
    handlers([{ handler: 'Fantastical', isMagical: false }]);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
  });

  it('claims the type and says so', async () => {
    await promptSetAsDefault(null);

    expect(sendToHelper).toHaveBeenCalledWith('defaults.claim', { target: 'ics' });
    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [{ message: string }];
    expect(options.message).toContain('is now the default reader');
  });

  it('says so when Magical already holds the type, rather than doing nothing', async () => {
    handlers([{ handler: 'Magical', isMagical: true }]);

    await promptSetAsDefault(null);

    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(sendToHelper).not.toHaveBeenCalledWith('defaults.claim', expect.anything());
  });

  it('ignores the Don’t Ask Again setting, unlike the launch prompt', async () => {
    settings.askAboutDefaultCalendarApp = false;

    await promptSetAsDefault(null);

    expect(dialog.showMessageBox).toHaveBeenCalled();
    settings.askAboutDefaultCalendarApp = true;
  });

  it('explains rather than claims when there is no bundle to register', async () => {
    handlers([{ handler: 'Fantastical', isMagical: false }], false);

    await promptSetAsDefault(null);

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [{ message: string }];
    expect(options.message).toContain('Only the installed Magical');
    expect(sendToHelper).not.toHaveBeenCalledWith('defaults.claim', expect.anything());
  });

  it('explains when the helper cannot be reached', async () => {
    helper.available = false;

    await promptSetAsDefault(null);

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [{ message: string }];
    expect(options.message).toContain('could not read');
  });
});

describe('claimDefault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    helper.available = true;
  });

  it('reports failure rather than throwing when the helper refuses', async () => {
    sendToHelper.mockRejectedValueOnce(new Error('helper gone'));
    expect(await claimDefault('ics')).toBe(false);
  });

  it('reports failure when there is no helper at all', async () => {
    helper.available = false;
    expect(await claimDefault('ics')).toBe(false);
  });
});
