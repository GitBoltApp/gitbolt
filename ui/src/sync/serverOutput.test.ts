import { beforeEach, describe, expect, it } from 'vitest';
import { useActivityUi } from '../app/activityLog';
import { useToast } from '../ui/toast';
import { serverActions, showServerResult } from './serverOutput';

describe('server output toasts (spec #2 §12.4)', () => {
  beforeEach(() => useToast.getState().dismiss());

  it('links "Server output (N lines)" only when there is something to read', () => {
    expect(serverActions({ lines: 0, warning: null }, 3)).toEqual([]);
    const [link] = serverActions({ lines: 2, warning: null }, 3);
    expect(link.label).toBe('Server output (2 lines)');
    link.run();
    expect(useActivityUi.getState()).toMatchObject({ open: true, view: 'activity', focusOp: 3 });
    expect(serverActions({ lines: 1, warning: null }, 3)[0].label).toBe('Server output (1 line)');
  });

  it('a Warning line makes a sticky warning toast quoting it', () => {
    showServerResult('Pushed dev to origin/dev', 'Pushed dev to origin/dev; the server reported a problem', { lines: 2, warning: 'integration: rebase onto dev failed: conflict in a.txt' }, 5);
    const t = useToast.getState();
    expect(t.message).toBe('Pushed dev to origin/dev; the server reported a problem');
    expect(t.tone).toBe('warning');
    expect(t.sticky).toBe(true);
    expect(t.detail).toBe('“integration: rebase onto dev failed: conflict in a.txt”');
    expect(t.actions.map((a) => a.label)).toEqual(['Server output (2 lines)']);
  });

  it('no warning: the plain done text with the link', () => {
    showServerResult('Pushed main to origin/main', 'unused', { lines: 1, warning: null }, 6);
    expect(useToast.getState()).toMatchObject({ message: 'Pushed main to origin/main', tone: null, sticky: false });
  });
});
