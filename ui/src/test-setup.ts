import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// vite.config.ts doesn't set `test.globals`, so testing-library's own auto-cleanup (which
// detects a global `afterEach`) never registers. Without this, each render() in a test file
// piles onto the previous one's DOM, and later `getByRole` queries see duplicates.
afterEach(() => cleanup());

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollTo ??= function scrollTo() {} as typeof Element.prototype.scrollTo;

// jsdom does no layout, so offsetWidth/offsetHeight (and clientHeight) are always 0. That
// clobbers @tanstack/react-virtual's `initialRect` on mount (its default `observeElementRect`
// measures the scroll element via offsetWidth/offsetHeight), leaving no rows virtualized.
// Report a plausible viewport size instead so components under test render their rows.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1200 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
