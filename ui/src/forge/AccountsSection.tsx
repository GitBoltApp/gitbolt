import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { ForgeAccountView } from '../api/gen/ForgeAccountView';
import type { ForgeKind } from '../api/gen/ForgeKind';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { resetAvatars } from '../avatars/avatarStore';
import { notifyForgeAccountsChanged } from './accountsBus';
import { escOwners } from '../app/modalKeys';
import { GitHubMark, GitLabMark } from '../icons/brands';
import { HostCombobox, type HostSuggestion } from './HostCombobox';
import { confirmAction } from '../ui/ConfirmDialog';
import { detectHostKind } from './hostKind';
import { effectiveKind } from './urls';
import './accounts.css';

export const FILE_WARNING = 'Stored in a file, not the system keyring: install or start a Secret Service (GNOME Keyring, KWallet), then restart GitBolt to secure it.';
const KINDS: Array<[ForgeKind, string]> = [['gitlab', 'GitLab'], ['github', 'GitHub']];

/** What an account's last requests said, in plain words; `null` when all is well. */
export function statusText(v: ForgeAccountView): string | null {
  const s = v.status;
  switch (s.kind) {
    case 'ok': return null;
    case 'rateLimited': return `Rate limited until ${new Date(s.until * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    case 'authFailed':
    case 'unreachable': return s.message;
    case 'tokenMissing': return 'Token missing: replace it to reconnect';
  }
}

/** The status chip: its tone and words. */
export function statusChip(v: ForgeAccountView): { tone: 'ok' | 'warn' | 'err'; label: string } {
  const s = v.status;
  switch (s.kind) {
    case 'ok': return { tone: 'ok', label: 'Connected' };
    case 'rateLimited': return { tone: 'warn', label: `Rate limited until ${new Date(s.until * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` };
    case 'authFailed': return { tone: 'err', label: 'Token rejected' };
    case 'unreachable': return { tone: 'err', label: 'Unreachable' };
    case 'tokenMissing': return { tone: 'err', label: 'Token missing' };
  }
}

type Panel = { mode: 'add' } | { mode: 'replace'; host: string; kind: ForgeKind };
const TOKEN_HELP: Record<ForgeKind, string> = {
  gitlab: 'Opens your profile\'s token page with the api scope selected. Copy the token, then paste it here.',
  github: 'Opens GitHub\'s fine-grained token page with the permissions GitBolt needs selected. Some organizations cap these tokens\' lifetime (e.g. 90 days); use a classic token for those.',
};
const CLASSIC_HELP = 'Opens GitHub\'s classic token page with the repo and read:org scopes selected. Classic tokens don\'t expire unless you set a date.';
/** GitHub's answer when an organization caps fine-grained token lifetimes. */
const FINE_GRAINED_REFUSED = 'forbids access via a fine-grained';


/** Settings › Accounts (spec #4 §3.2): the active profile's forge accounts, one per host. */
export function AccountsSection() {
  const [accounts, setAccounts] = useState<ForgeAccountView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const refocusAdd = useRef(false);
  const reload = useCallback(async (keepError = false) => {
    try {
      setAccounts(await api.forgeAccounts());
      if (!keepError) setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!panel && refocusAdd.current) { refocusAdd.current = false; addButton.current?.focus(); }
  }, [panel]);
  const close = useCallback(() => { refocusAdd.current = true; setPanel(null); }, []);
  // Avatars: what the backend answers depends on the accounts (forge avatars come first).
  const changed = async () => {
    await reload();
    resetAvatars();
    notifyForgeAccountsChanged();
  };
  const remove = async (host: string) => {
    const ok = await confirmAction({
      title: `Remove the ${host} account?`,
      body: `Its token is deleted from this computer. Revoke it on ${host} too if you no longer need it.`,
      confirmLabel: 'Remove account',
      arm: `Click again to remove the ${host} account`,
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeForgeAccount(host);
    } catch (e) {
      // The list is read again, but the error stays to be read.
      setError(errorMessage(e));
      await reload(true);
      return;
    }
    await changed();
  };
  const addButtonEl = (primary: boolean) => (
    <button ref={addButton} type="button" className={primary ? 'primary' : undefined} onClick={() => setPanel({ mode: 'add' })}>+ Add account</button>
  );
  return (
    <div className="accounts-box" id="setting-forgeAccounts" data-setting-id="forgeAccounts">
      <p className="dim accounts-help">
        Connect GitLab or GitHub to see merge requests, pull requests and forks. One account per host.
        {accounts?.length === 0 && ' Tokens are kept in the system keyring.'}
      </p>
      {error && <p role="alert" className="setting-error">{error}</p>}
      {accounts?.length === 0 && !panel && (
        <div className="accounts-empty">
          <p>No accounts yet.</p>
          {addButtonEl(true)}
        </div>
      )}
      {accounts && accounts.length > 0 && (
        <ul className="accounts" aria-label="Forge accounts">
          {accounts.map((v) => (
            <AccountRow key={v.account.host} v={v} onReplace={() => setPanel({ mode: 'replace', host: v.account.host, kind: v.account.kind })} onRemove={() => void remove(v.account.host)} />
          ))}
        </ul>
      )}
      {panel && <AddAccount key={panel.mode === 'replace' ? panel.host : 'add'} panel={panel} taken={accounts?.map((a) => a.account.host) ?? []} onAdded={async () => { await changed(); close(); }} onCancel={close} onReplace={(host, kind) => setPanel({ mode: 'replace', host, kind })} />}
      {!panel && accounts && accounts.length > 0 && addButtonEl(false)}
    </div>
  );
}

function AccountRow({ v, onReplace, onRemove }: { v: ForgeAccountView; onReplace(): void; onRemove(): void }) {
  const a = v.account;
  const note = statusText(v);
  const chip = statusChip(v);
  const file = a.storage === 'file';
  const gitlab = a.kind === 'gitlab';
  return (
    <li className="account" aria-label={`${a.host} account`}>
      <span className={`forge-mark ${gitlab ? 'is-gitlab' : 'is-github'}`}>{gitlab ? <GitLabMark size={18} /> : <GitHubMark size={18} />}</span>
      <div className="account-main">
        <div className="account-line">
          <span className="account-name">{a.user.name}</span>{' '}
          <span className="dim">@{a.user.username}</span>
        </div>
        <div className="account-meta dim">
          <span>{a.host} · {gitlab ? 'GitLab' : 'GitHub'}{a.version ? ` ${a.version}` : ''}</span>
          <span className={`chip is-${chip.tone}`}>● {chip.label}</span>
          <span className={`chip${file ? ' is-warn' : ''}`}>{file ? 'File — not secure' : 'System keyring'}</span>
        </div>
        {file && <p className="account-note is-warn">{FILE_WARNING}</p>}
        {note && chip.tone === 'err' && <p className="account-note is-err" role="status">{note}{v.status.kind === 'authFailed' ? ' Replace it to reconnect.' : ''}</p>}
      </div>
      <div className="account-actions">
        <button type="button" className={chip.tone === 'err' ? undefined : 'ghost'} aria-label={`Replace the token for ${a.host}`} onClick={onReplace}>Replace token</button>
        <button type="button" className="ghost danger" aria-label={`Remove the ${a.host} account`} onClick={onRemove}>Remove</button>
      </div>
    </li>
  );
}

/** Host (the open repo's forge hosts first), forge, Create token, the token; Cancel / Add account. */
function AddAccount({ panel, taken, onAdded, onCancel, onReplace }: { panel: Panel; taken: string[]; onAdded(): Promise<void>; onCancel(): void; onReplace(host: string, kind: ForgeKind): void }) {
  const replacing = panel.mode === 'replace';
  const activeTab = useAppState((s) => s.profile.activeTab);
  const overrides = useAppState((s) => s.profile.hostOverrides);
  const tab = useRuntime((s) => (activeTab ? s.tabs[activeTab] : undefined));
  const remotes = tab?.info?.remotes;
  const repoName = tab?.repo?.name;
  const suggestions = useMemo<HostSuggestion[]>(() => {
    const seen = new Set<string>();
    const out: HostSuggestion[] = [];
    for (const r of remotes ?? []) {
      if (!r.host || seen.has(r.host) || taken.includes(r.host) || effectiveKind(r.host, r.hostKind, overrides) === 'generic') continue;
      seen.add(r.host);
      out.push({ host: r.host, source: repoName ? `${r.name} · ${repoName}` : r.name });
    }
    return out;
  }, [remotes, overrides, taken, repoName]);
  const [typed, setTyped] = useState<string | null>(replacing ? panel.host : null);
  const [pickedEarly, setPickedEarly] = useState<ForgeKind | null>(replacing ? panel.kind : null);
  // Untyped, the host follows the forge picked: its first suggestion, and for GitHub otherwise
  // github.com (GitHub Enterprise Server is out of scope).
  const kindOf = (h: string) => effectiveKind(h, detectHostKind(h), overrides);
  const host = typed
    ?? (pickedEarly === null
      ? suggestions[0]?.host ?? ''
      : suggestions.find((x) => kindOf(x.host) === pickedEarly)?.host ?? (pickedEarly === 'github' ? 'github.com' : ''));
  const detected = host ? effectiveKind(host, detectHostKind(host), overrides) : 'generic';
  const picked = pickedEarly;
  const setPicked = setPickedEarly;
  // One account per host: a host that has one already gets its token replaced instead.
  const takenHost = !replacing && host !== '' && taken.includes(host);
  const kind: ForgeKind = picked ?? (detected === 'github' ? 'github' : 'gitlab');
  const [classic, setClassic] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const listOpen = useRef(false);
  const closeList = useRef<(() => void) | null>(null);
  useEffect(() => { (replacing || host ? tokenRef : hostRef).current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Esc: the host list first (its own handler), then the panel, before the Settings dialog sees it.
  useEffect(() => {
    const own = (e: KeyboardEvent) => {
      if (!(e.target instanceof Node) || !formRef.current?.contains(e.target)) return false;
      if (listOpen.current) { closeList.current?.(); return true; }
      setToken('');
      onCancel();
      return true;
    };
    escOwners.add(own);
    return () => { escOwners.delete(own); };
  }, [onCancel]);
  const openTokenPage = async () => {
    try {
      await api.openUrl(await api.forgeTokenPage(host, kind, kind === 'github' ? classic : undefined));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const submit = async () => {
    if (!host || !token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addForgeAccount(host, kind, token);
      setToken('');
      await onAdded();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const title = replacing ? `Replace the token for ${panel.host}` : 'Add a forge account';
  return (
    <form ref={formRef} className="account-add" aria-label={title} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h4>{title}</h4>
      <div className="field">
        <label htmlFor="account-host">Host</label>
        {replacing
          ? <input id="account-host" aria-label="Host" readOnly value={host} />
          : <div><HostCombobox inputRef={hostRef} value={host} suggestions={suggestions} onChange={(h) => { setTyped(h); setPicked(null); }} onOpenChange={(o) => { listOpen.current = o; }} closeRef={closeList} /></div>}
        {takenHost && (
          <p className="field-help account-taken" role="status">
            {host} already has an account.{' '}
            <button type="button" className="link-btn" onClick={() => onReplace(host, kind)}>Replace its token</button>
          </p>
        )}
      </div>
      <div className="field">
        <span className="field-label">Forge</span>
        <div className="field-row">
          <div className="seg" role="group" aria-label="Forge type">
            {KINDS.map(([k, name]) => <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'is-on' : undefined} onClick={() => setPicked(k)}>{name}</button>)}
          </div>
          <span className="dim">{picked === null && host ? 'Detected from the host' : ''}</span>
        </div>
      </div>
      {kind === 'github' && (
        <div className="field">
          <span className="field-label">Token type</span>
          <div className="field-row">
            <div className="seg" role="group" aria-label="Token type">
              {([[false, 'Fine-grained'], [true, 'Classic']] as const).map(([c, name]) => <button key={name} type="button" aria-pressed={classic === c} className={classic === c ? 'is-on' : undefined} onClick={() => setClassic(c)}>{name}</button>)}
            </div>
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="account-token">Token</label>
        <div className="field-row">
          <input ref={tokenRef} id="account-token" aria-label="Token" type="password" autoComplete="off" spellCheck={false} placeholder="Paste the personal access token" value={token} onChange={(e) => setToken(e.target.value)} />
          <button type="button" disabled={!host || takenHost} title={!host ? 'Enter the host first' : undefined} onClick={() => void openTokenPage()}>Create token on {host || 'the host'} ↗</button>
        </div>
        <p className="dim field-help">{kind === 'github' && classic ? CLASSIC_HELP : TOKEN_HELP[kind]}</p>
      </div>
      <div className="account-foot">
        <p className="setting-error account-add-error" role={error ? 'alert' : undefined}>
          {error}
          {error && kind === 'github' && !classic && error.includes(FINE_GRAINED_REFUSED) && (
            <>{' '}<button type="button" className="link-btn" onClick={() => { setClassic(true); setError(null); }}>Use a classic token instead</button></>
          )}
        </p>
        <button type="button" className="ghost" onClick={() => { setToken(''); onCancel(); }}>Cancel</button>
        <button type="submit" className="primary account-submit" aria-busy={busy} disabled={!host || takenHost || !token.trim() || busy}>{busy ? 'Checking…' : replacing ? 'Replace token' : 'Add account'}</button>
      </div>
    </form>
  );
}
