import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const logFrontend = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../api/client', () => ({ api: { logFrontend } }));
import { PanelErrorBoundary } from './PanelErrorBoundary';

let broken = true;
function Child() {
  if (broken) throw new Error('boom');
  return <p>fine</p>;
}

it('clears itself when resetKey changes', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const was = broken;
  broken = true;
  const { rerender } = render(<PanelErrorBoundary name="Details" resetKey="a"><Child /></PanelErrorBoundary>);
  expect(screen.getByRole('alert')).toBeTruthy();
  broken = false;
  rerender(<PanelErrorBoundary name="Details" resetKey="b"><Child /></PanelErrorBoundary>);
  expect(screen.getByText('fine')).toBeTruthy();
  broken = was;
});

it('shows a fallback with Retry, logs the crash, and remounts on Retry', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<PanelErrorBoundary name="Graph"><Child /></PanelErrorBoundary>);
  expect(screen.getByRole('alert').textContent).toContain('Graph crashed: boom');
  expect(logFrontend).toHaveBeenCalledWith('error', 'Graph panel crashed: boom', expect.stringContaining('boom'));
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(screen.getByText('fine')).toBeTruthy();
});
