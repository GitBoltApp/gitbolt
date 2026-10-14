import { describe, expect, it } from 'vitest';
import { classify, summarize } from './serverLines';

describe('server lines', () => {
  it('counts what a person reads, not GitLab\'s links or blank lines', () => {
    const lines = classify(['', 'To create a merge request for feature/ünï, visit:', '  https://gitlab.example.com/orbital/orbital/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2F%C3%BCn%C3%AF', '', 'Deployed preview', 'integration: rebase failed: conflict in a.txt']);
    expect(lines.map((l) => l.kind)).toEqual(['boilerplate', 'boilerplate', 'boilerplate', 'boilerplate', 'info', 'warning']);
    expect(summarize(lines)).toEqual({ lines: 2, warning: 'integration: rebase failed: conflict in a.txt' });
  });

  it('as the core: meters and percentages are boilerplate, a URL only after its intro, credentials redacted', () => {
    const lines = classify(['Counting objects: 100% (2/2), done.', 'Resolving deltas:  50% (1/2)', 'View merge request for dev:', '  https://gitlab.example.com/orbital/orbital/-/merge_requests/3', 'see https://ci.example.com/run/1', 'mirror at https://ada:secret@ci.example.com/x   ']);
    expect(lines.map((l) => l.kind)).toEqual(['boilerplate', 'boilerplate', 'boilerplate', 'boilerplate', 'info', 'info']);
    expect(lines[5].text).toBe('mirror at https://***@ci.example.com/x');
    expect(summarize(classify([]))).toEqual({ lines: 0, warning: null });
  });
});
