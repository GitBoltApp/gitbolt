import { useState } from 'react';
import { create } from 'zustand';
import type { PushTarget } from '../api/gen/PushTarget';
import { useModalKeys } from '../app/modalKeys';
import { Select } from '../ui/Select';
import './push.css';

interface Req { id: number; branch: string; remotes: string[]; resolve(t: PushTarget | null): void }
let nextId = 0;
const useAsk = create<{ req: Req | null }>(() => ({ req: null }));

/** Asks where a branch with no upstream goes; `null` on Cancel, Esc, the backdrop or a newer ask. */
export function askPushTarget(branch: string, remotes: string[]): Promise<PushTarget | null> {
  useAsk.getState().req?.resolve(null);
  const sorted = [...remotes].sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
  return new Promise((resolve) => useAsk.setState({ req: { id: ++nextId, branch, remotes: sorted, resolve } }));
}

export function PushUpstreamDialog() {
  const req = useAsk((s) => s.req);
  return req ? <Form req={req} key={req.id} /> : null;
}

function Form({ req }: { req: Req }) {
  const [remote, setRemote] = useState(req.remotes[0]);
  const [branch, setBranch] = useState(req.branch);
  const done = (t: PushTarget | null) => {
    useAsk.setState({ req: null });
    req.resolve(t);
  };
  const ref = useModalKeys<HTMLDivElement>(true, () => done(null));
  const ok = branch.trim() !== '';
  return (
    <div className="modal-backdrop" onPointerDown={() => done(null)}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={`Push ${req.branch} to a remote`} onPointerDown={(e) => e.stopPropagation()}>
        <form onSubmit={(e) => { e.preventDefault(); if (ok) done({ remote, branch: branch.trim() }); }}>
          <div className="push-target">
            <span>{`Push ${req.branch} to`}</span>
            <Select<string> aria-label="Remote" value={remote} options={req.remotes.map((r) => [r, r] as const)} onChange={setRemote} />
            <span aria-hidden>/</span>
            <input aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
            <span>and track it?</span>
          </div>
          <div className="modal-actions">
            <button type="button" autoFocus onClick={() => done(null)}>Cancel</button>
            <button type="submit" disabled={!ok}>Push</button>
          </div>
        </form>
      </div>
    </div>
  );
}
