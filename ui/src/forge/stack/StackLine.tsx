import { useMemo } from 'react';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import { useRuntime } from '../../app/runtime';
import { mrChain, stackLine, type MrChain } from './chain';
import { forgeTarget, useTabForgeField, type ForgeTarget } from './deps';
import { stackEnvOf } from './env';
import './stack.css';

/** The forge and runtime inputs `stackEnvOf` reads: a memo over them recomputes only when one changes. */
export function useStackInputs(tabId: string): unknown[] {
  const byRef = useTabForgeField(tabId, 'byRef');
  const upstreams = useTabForgeField(tabId, 'upstreams');
  const project = useTabForgeField(tabId, 'project');
  const remote = useTabForgeField(tabId, 'remote');
  const kind = useTabForgeField(tabId, 'kind');
  const sidebar = useRuntime((s) => s.tabs[tabId]?.sidebar);
  const graph = useRuntime((s) => s.tabs[tabId]?.graph);
  return [byRef, upstreams, project, remote, kind, sidebar?.locals, sidebar?.remotes, graph];
}

/** The chain through `mr` (Ruling 13), re-read when 4B's forge store or the tab's branches change. */
export function useMrChain(tabId: string, mr: ForgeMr): { chain: MrChain | null; target: ForgeTarget | null } {
  const inputs = useStackInputs(tabId);
  return useMemo(() => {
    const target = forgeTarget(tabId);
    const env = stackEnvOf(tabId);
    if (!target || !env) return { chain: null, target: null };
    return { chain: mrChain(mr, env), target };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, mr, ...inputs]);
}

/** The hover card's stack line (spec #4 §4 4D: badges show the stack): `Stack 2 of 3 (below: !1, above: !3)`. */
export function StackLine({ tabId, mr }: { tabId: string; mr: ForgeMr }) {
  const { chain, target } = useMrChain(tabId, mr);
  if (!chain || !target) return null;
  return <div className="mr-stack-line">{stackLine(chain, target.kind)}</div>;
}
