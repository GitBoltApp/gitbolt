import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeUser } from '../../api/gen/ForgeUser';

vi.mock('../../api/client', () => ({ api: {}, errorMessage: (e: unknown) => String((e as { message: string }).message) }));
const { PeopleCard } = await import('./PeopleCard');

const user = (id: number, name: string): ForgeUser => ({ id, username: name.toLowerCase(), name, avatarUrl: null, webUrl: '', email: null });
const ada = user(1, 'Ada Lovelace');
const grace = user(2, 'Grace Hopper');

function Editable({ onEsc }: { onEsc?: () => void }) {
  const [people, setPeople] = useState<ForgeUser[]>([ada]);
  return (
    <div onKeyDown={(e) => { if (e.key === 'Escape') onEsc?.(); }}>
      <PeopleCard rows={[{
        label: 'Reviewers', noun: 'reviewer', chips: people.map((u) => ({ key: String(u.id), label: u.name, user: u })),
        edit: {
          search: async () => [ada, grace].map((u) => ({ key: String(u.id), label: u.name, value: () => setPeople((p) => [...p, u]) })),
          onRemove: (k) => setPeople((p) => p.filter((u) => String(u.id) !== k)),
        },
      }]} />
    </div>
  );
}

describe('PeopleCard', () => {
  it('editable: + Add opens the search, a pick adds a chip (the chosen are left out of the matches), × removes', async () => {
    render(<Editable />);
    const card = screen.getByRole('group', { name: 'People and labels' });
    expect(within(card).getByText('Ada Lovelace')).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Add reviewer' });
    expect(add).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(add);
    expect(add).toHaveAttribute('aria-expanded', 'true');
    const box = screen.getByRole('combobox', { name: 'Reviewers' });
    expect(document.activeElement).toBe(box);
    expect(await screen.findByRole('option', { name: 'Grace Hopper' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Ada Lovelace' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Grace Hopper' }));
    expect(within(card).getByText('Grace Hopper')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace' }));
    expect(within(card).queryByText('Ada Lovelace')).toBeNull();
  });

  it('Esc closes the search and gives the focus back to + Add, and goes no further; a press outside closes it too', () => {
    const onEsc = vi.fn();
    render(<Editable onEsc={onEsc} />);
    const add = screen.getByRole('button', { name: 'Add reviewer' });
    fireEvent.click(add);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Reviewers' }), { key: 'Escape' });
    expect(screen.queryByRole('combobox', { name: 'Reviewers' })).toBeNull();
    expect(document.activeElement).toBe(add);
    expect(onEsc).not.toHaveBeenCalled();
    fireEvent.click(add);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('combobox', { name: 'Reviewers' })).toBeNull();
  });

  it('+ Add toggles: pressing it again closes the search (its blur toward the button must not close it first)', () => {
    render(<Editable />);
    const add = screen.getByRole('button', { name: 'Add reviewer' });
    fireEvent.click(add);
    const box = screen.getByRole('combobox', { name: 'Reviewers' });
    // A real press: the search loses the focus to the button, then the button's click.
    fireEvent.pointerDown(add);
    fireEvent.blur(box, { relatedTarget: add });
    fireEvent.click(add);
    expect(screen.queryByRole('combobox', { name: 'Reviewers' })).toBeNull();
    expect(add).toHaveAttribute('aria-expanded', 'false');
  });

  it('read-only: the chips alone, no + Add or ×; an empty row says None, an unloaded one Loading…', async () => {
    render(<PeopleCard rows={[
      { label: 'Reviewers', noun: 'reviewer', chips: [{ key: '1', label: 'Ada Lovelace', user: ada }] },
      { label: 'Assignees', noun: 'assignee', chips: [] },
      { label: 'Labels', noun: 'label', chips: [{ key: 'bug', label: 'bug :gear:', color: '#a2eeef' }, { key: 'plain', label: 'plain', color: null }] },
      { label: 'Approvers', noun: 'approver', chips: null },
    ]} />);
    const card = screen.getByRole('group', { name: 'People and labels' });
    expect(within(card).queryByRole('button')).toBeNull();
    expect(card).toHaveTextContent(/Assignees\s*None/);
    expect(card).toHaveTextContent(/Approvers\s*Loading…/);
    const pill = (await screen.findByText('bug ⚙️')).closest('.people-pill') as HTMLElement;
    expect([pill.hasAttribute('data-colored'), pill.style.getPropertyValue('--chip-color'), pill.style.getPropertyValue('--chip-text')]).toEqual([true, '#a2eeef', '#000']);
    expect(screen.getByText('plain').closest('.people-pill')!.hasAttribute('data-colored')).toBe(false);
  });

  it('disabled: + Add and × are disabled', () => {
    render(<PeopleCard disabled rows={[{ label: 'Labels', noun: 'label', chips: [{ key: 'bug', label: 'bug', color: null }], edit: { search: async () => [], onRemove: () => {} } }]} />);
    expect(screen.getByRole('button', { name: 'Add label' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove bug' })).toBeDisabled();
  });
});
