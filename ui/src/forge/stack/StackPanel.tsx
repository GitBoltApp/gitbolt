import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import { useRuntime } from '../../app/runtime';
import { writeCtx } from '../../write/ctx';
import { mainWorktreeOf } from '../../worktrees/active';
import { worktreeDisplay } from '../../worktrees/paths';
import { EmojiText } from '../emoji';
import { mrRef } from '../labels';
import { afterMerge, MR_STATE_WORDS } from './chain';
import { openMrView } from './deps';
import { inProgressOf, stackEnvOf } from './env';
import { afterMergeBlocked, afterMergeLabel, retargetAndRebase } from './retarget';
import { useMrChain, useStackInputs } from './StackLine';
import './stack.css';

/**
 * The MR/PR view's Stack panel (spec #4 §4 4D): the chain bottom to top, this one marked, the
 * others opening their own view. After the bottom merged: the one-click retarget and rebase (its
 * Rebase stack confirm arms this button in place).
 */
export function StackPanel({ tabId, mr }: { tabId: string; mr: ForgeMr }) {
  const { chain, target } = useMrChain(tabId, mr);
  const { sb, graph, repo } = useRuntime(useShallow((s) => ({ sb: s.tabs[tabId]?.sidebar, graph: s.tabs[tabId]?.graph, repo: s.tabs[tabId]?.repo })));
  const inputs = useStackInputs(tabId);
  const headBranch = graph?.head.branch?.replace(/^refs\/heads\//, '') ?? null;
  const a = useMemo(
    () => {
      const env = stackEnvOf(tabId);
      return env ? afterMerge(mr.sourceBranch, env) : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabId, mr, ...inputs],
  );
  // After a forge retarget (native GitLab, GitHub) the merged one is no longer below: the after-merge part still shows.
  if (!target || (!chain && !a)) return null;
  const kind = target.kind;
  // The same worktree naming T8's menu env uses (worktreeDisplay against the main worktree).
  const main = mainWorktreeOf(tabId) ?? repo?.path ?? '';
  const blocked = a && sb ? afterMergeBlocked(a, { headBranch, inProgress: inProgressOf(tabId), locals: sb.locals, worktreeShown: (p) => worktreeDisplay(main, p) }) : undefined;
  return (
    <section className="mr-stack" aria-label="Stack">
      <h3>Stack</h3>
      {chain && <ol>
        {chain.mrs.map((m, i) => (
          <li key={m.number} aria-current={i === chain.index ? 'true' : undefined}>
            {i === chain.index ? (
              <span className="mr-stack-this">{mrRef(kind, m.number)} <EmojiText text={m.title} /></span>
            ) : (
              <button type="button" className="mr-stack-link" onClick={() => openMrView(tabId, m.number)}>{mrRef(kind, m.number)} <EmojiText text={m.title} /></button>
            )}
            <span className="mr-stack-state">{MR_STATE_WORDS[m.state]}</span>
          </li>
        ))}
      </ol>}
      {a && (
        <div className="mr-stack-after">
          <button type="button" disabled={!!blocked} onClick={() => { const ctx = writeCtx(tabId); if (ctx) void retargetAndRebase(ctx, a, target); }}>{afterMergeLabel(a, kind)}</button>
          {blocked && <p className="mr-stack-caption">{blocked}</p>}
        </div>
      )}
    </section>
  );
}
