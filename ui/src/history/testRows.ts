import type { FileHistoryRow } from '../api/gen/FileHistoryRow';

/** A history row for tests: `sha`, its status and its path at that commit. */
export const row = (sha: string, status = 'M', path = 'src/story.txt'): FileHistoryRow => ({ sha, parents: [], author: 'Ada Lovelace', email: 'ada@example.com', time: 1_767_225_600, summary: `Commit ${sha}`, path, status, oldPath: null });
