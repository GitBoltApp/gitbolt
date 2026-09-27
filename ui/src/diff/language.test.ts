import { describe, expect, it } from 'vitest';
import { detectLanguage, highlightLanguage, HIGHLIGHT_MAX_LINES } from './language';

describe('language detection', () => {
  it('uses Shiki ids and aliases, then extra extensions and file names, then the shebang', () => {
    expect(detectLanguage('src/app.php')).toBe('php');
    expect(detectLanguage('ui/x.ts')).toBe('typescript');
    expect(detectLanguage('ui/x.tsx')).toBe('tsx');
    expect(detectLanguage('ci.YML')).toBe('yaml');
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('view.phtml')).toBe('php');
    expect(detectLanguage('lib/x.h')).toBe('c');
    expect(detectLanguage('Dockerfile')).toBe('docker');
    expect(detectLanguage('sub/Makefile')).toBe('make');
    expect(detectLanguage('.env.local')).toBe('dotenv');
    expect(detectLanguage('bin/tool', '#!/usr/bin/env python3')).toBe('python');
    expect(detectLanguage('bin/run', '#!/bin/bash')).toBe('shellscript');
    expect(detectLanguage('notes.txt')).toBe('plaintext');
    expect(detectLanguage('LICENSE')).toBe('plaintext');
  });

  it('never returns an Object.prototype member for names like constructor or __proto__', () => {
    for (const path of ['constructor', 'x.constructor', '__proto__', 'x.__proto__', 'x.hasOwnProperty', 'x.toString']) {
      expect(detectLanguage(path), path).toBe('plaintext');
    }
    expect(detectLanguage('bin/x', '#!/usr/bin/env constructor')).toBe('plaintext');
  });

  it('falls back to plain text above 1 MiB or 20k lines', () => {
    expect(highlightLanguage('a.php', '<?php\n')).toBe('php');
    expect(highlightLanguage('a.php', 'x'.repeat(1_048_576))).toBe('php');
    expect(highlightLanguage('a.php', 'x'.repeat(1_048_577))).toBe('plaintext');
    expect(highlightLanguage('a.php', 'x\n'.repeat(HIGHLIGHT_MAX_LINES + 1))).toBe('plaintext');
  });
});
