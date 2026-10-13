// Arm in place (AGENTS.md, UI conventions): the first click arms the button, whose label then says
// what a second click does, in red; the second click runs it. A press anywhere else, Esc, or focus
// leaving the button or the page (into the demo's frame) disarms. No timer. Both labels are in the
// button at once (site.css stacks them), so arming moves nothing.
export function armInPlace(button: HTMLButtonElement, doc: Document, win: Pick<Window, 'addEventListener'>, run: () => void, shouldArm: () => boolean = () => true): void {
  const disarm = () => button.classList.remove('armed');
  button.addEventListener('click', () => {
    if (button.classList.contains('armed') || !shouldArm()) {
      disarm();
      run();
      return;
    }
    button.classList.add('armed');
  });
  doc.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Node) || !button.contains(e.target)) disarm();
  }, true);
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') disarm();
  });
  button.addEventListener('focusout', disarm);
  win.addEventListener('blur', disarm);
}
