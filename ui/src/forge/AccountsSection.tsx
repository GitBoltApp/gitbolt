import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { ForgeAccountView } from '../api/gen/ForgeAccountView';
import type { ForgeKind } from '../api/gen/ForgeKind';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { Avatar } from '../avatars/Avatar';
import { avatars } from '../avatars/avatarStore';
import { notifyForgeAccountsChanged } from './accountsBus';
import { Row } from '../settings/Row';
import { confirmAction } from '../ui/ConfirmDialog';
import { Select } from '../ui/Select';
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
    case 'tokenMissing': return 'Token missing: add the account again';
  }
}

/** Settings › Accounts (spec #4 §3.2): the active profile's forge accounts, one per host. */
export function AccountsSection() {
  const [accounts, setAccounts] = useState<ForgeAccountView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async (keepError = false) => {
    try {
      setAccounts(await api.forgeAccounts());
      if (!keepError) setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  // Avatars: what the backend answers depends on the accounts (forge avatars come first).
  const changed = async () => {
    await reload();
    avatars.reset();
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
  return (
    <Row id="forgeAccounts" group>
      <div className="accounts-box">
        {error && <p role="alert" className="setting-error">{error}</p>}
        {accounts?.length === 0 && <span className="dim">No accounts yet. Add one to see merge requests, pull requests and forks.</span>}
        {accounts && accounts.length > 0 && (
          <ul className="accounts" aria-label="Forge accounts">
            {accounts.map((v) => <AccountRow key={v.account.host} v={v} onRemove={() => void remove(v.account.host)} />)}
          </ul>
        )}
        <AddAccount taken={accounts?.map((a) => a.account.host) ?? []} onAdded={changed} />
      </div>
    </Row>
  );
}

function AccountRow({ v, onRemove }: { v: ForgeAccountView; onRemove(): void }) {
  const a = v.account;
  const status = statusText(v);
  const file = a.storage === 'file';
  return (
    <li className="account" aria-label={`${a.host} account`}>
      <Avatar name={a.user.name} email={a.user.email ?? ''} size={24} />
      <div className="account-main">
        <div className="account-line">
          <span className="account-name">{a.user.name}</span>{' '}
          <span className="dim">@{a.user.username} · {a.host} · {a.kind === 'gitlab' ? 'GitLab' : 'GitHub'}{a.version ? ` ${a.version}` : ''}</span>
        </div>
        <div className={`account-storage${file ? ' is-file' : ''}`}>{file ? 'File — not secure' : 'System keyring'}</div>
        {file && <p className="account-warning">{FILE_WARNING}</p>}
        {status && <p className="account-status" role="status">{status}</p>}
      </div>
      <button type="button" aria-label={`Remove the ${a.host} account`} onClick={onRemove}><Trash2 size={13} aria-hidden /> Remove</button>
    </li>
  );
}

/** Host (the open repo's forge hosts first), kind, Create token, the token, Add account. */
function AddAccount({ taken, onAdded }: { taken: string[]; onAdded(): Promise<void> }) {
  const activeTab = useAppState((s) => s.profile.activeTab);
  const overrides = useAppState((s) => s.profile.hostOverrides);
  const remotes = useRuntime((s) => (activeTab ? s.tabs[activeTab]?.info?.remotes : undefined));
  const suggestions = useMemo(
    () => [...new Set((remotes ?? []).flatMap((r) => (r.host && effectiveKind(r.host, r.hostKind, overrides) !== 'generic' ? [r.host] : [])))].filter((h) => !taken.includes(h)),
    [remotes, overrides, taken],
  );
  const [typed, setTyped] = useState<string | null>(null);
  const host = typed ?? suggestions[0] ?? '';
  const detected = host ? effectiveKind(host, detectHostKind(host), overrides) : 'generic';
  const [picked, setPicked] = useState<ForgeKind | null>(null);
  const kind: ForgeKind = picked ?? (detected === 'github' ? 'github' : 'gitlab');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openTokenPage = async () => {
    try {
      await api.openUrl(await api.forgeTokenPage(host, kind));
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
      setTyped(null);
      setPicked(null);
      await onAdded();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="account-add" aria-label="Add a forge account" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input aria-label="Host" list="forge-host-suggestions" placeholder="gitlab.example.com" spellCheck={false} value={host} onChange={(e) => { setTyped(e.target.value); setPicked(null); }} />
      <datalist id="forge-host-suggestions">{suggestions.map((h) => <option key={h} value={h} />)}</datalist>
      <Select<ForgeKind> aria-label="Forge type" value={kind} onChange={setPicked} options={KINDS} />
      <button type="button" disabled={!host} onClick={() => void openTokenPage()}>Create token</button>
      <input aria-label="Token" type="password" autoComplete="off" spellCheck={false} placeholder="Paste the token" value={token} onChange={(e) => setToken(e.target.value)} />
      <button type="submit" className="account-submit" aria-busy={busy} disabled={!host || !token.trim() || busy}>{busy ? 'Checking…' : 'Add account'}</button>
      <p className="setting-error account-add-error" role={error ? 'alert' : undefined}>{error}</p>
    </form>
  );
}
