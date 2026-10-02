import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { askChoice, ChoiceDialog } from './ChoiceDialog';

describe('askChoice (spec #2 §12.2, §13.1)', () => {
  it('resolves the picked choice and the checkbox, Cancel focused first', async () => {
    render(<ChoiceDialog />);
    const p = askChoice({ title: 'main and origin/main have diverged (2 ahead, 3 behind).', body: 'Merging would conflict in 1 file.', choices: [{ id: 'rebase', label: 'Rebase', primary: true }, { id: 'merge', label: 'Merge' }], checkbox: { label: 'Also move 2 stacked branches', checked: true, detail: 'feature/a, feature/b' } });
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Merging would conflict in 1 file.');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(screen.getByRole('checkbox', { name: /Also move 2 stacked branches/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Rebase' }));
    await expect(p).resolves.toEqual({ choice: 'rebase', checked: false });
  });

  it('Cancel and Esc resolve null', async () => {
    render(<ChoiceDialog />);
    const p = askChoice({ title: 't', body: 'b', choices: [{ id: 'x', label: 'X' }] });
    fireEvent.keyDown(await screen.findByRole('alertdialog'), { key: 'Escape' });
    await expect(p).resolves.toEqual({ choice: null, checked: false });
  });
});
