import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ forgeSearchUsers: vi.fn() }));
vi.mock('../api/client', () => ({ api, errorMessage: String }));

const { MarkdownField } = await import('./MarkdownField');
const { patchForge, useForge } = await import('../forge/mrStore');
const { clearPickerCache } = await import('../forge/pickerCache');
const { projectOf, user } = await import('../forge/testMrs');
const { useRuntime } = await import('../app/runtime');

const ctx = { kind: 'forge', tabId: 't' } as const;
const withId = (name: string, id: number) => ({ ...user(name), id, username: name.toLowerCase().split(' ')[0] });
const ada = withId('Ada Lovelace', 1);
const bob = withId('Bob Stone', 2);
const cy = withId('Cy Searched', 3);

function Field() {
  const [v, setV] = useState('');
  return <MarkdownField label="Write a comment" value={v} onChange={setV} flavor="gitlab" context={ctx} />;
}
const type = (text: string) => {
  render(<Field />);
  const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Write a comment' });
  box.focus();
  fireEvent.change(box, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
  return box;
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPickerCache();
  useForge.setState({ byTab: {} });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  api.forgeSearchUsers.mockResolvedValue([cy]);
});

describe('@ mentions in the Markdown field', () => {
  it('lists the MR people first, then search results, and inserts @username and a space', async () => {
    patchForge('t', { kind: 'gitlab', remote: 'origin', project: projectOf(), openMr: 7, discussions: { 7: [{ id: 'd', resolvable: false, resolved: false, notes: [{ id: 'n', author: bob, body: 'x', createdAt: 0, system: false, position: null }] }] }, list: { mrs: [{ number: 7, author: ada } as never] } as never });
    const box = type('hi @');
    const opts = await screen.findAllByRole('option');
    expect(opts.map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('@ada'), expect.stringContaining('@bob')]));
    expect(opts[0].textContent).toContain('@ada');
    await screen.findByRole('option', { name: /@cy/ });
    expect(api.forgeSearchUsers).toHaveBeenCalledWith(4, 'origin', '');
    fireEvent.click(screen.getByRole('option', { name: /@bob/ }));
    expect(box).toHaveValue('hi @bob ');
  });

  it('is quiet in an email', () => {
    patchForge('t', { kind: 'gitlab', remote: 'origin', project: projectOf() });
    type('mail me@host');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('has no popup and no search without a forge project', async () => {
    useForge.setState({ byTab: {} });
    const box = type('hi @a');
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(api.forgeSearchUsers).not.toHaveBeenCalled();
  });
});
