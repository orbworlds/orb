'use client';
// "GitHub" section of the You tab. Connecting gives Orb the person's GitHub token, kept sealed on
// the server (src/server/reposync.ts): worlds linked to a repository then sync both ways, and with
// "Keep every world on GitHub" each world of theirs gets a private repository of its own. OAuth
// when the server has it configured (/api/github/login → #gh_token=…), otherwise a pasted token.

import { useEffect, useId, useState } from 'react';
import { api, ApiError, type GitHubConnection } from '@/lib/api';
import { readJSON } from '@/lib/local';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { Switch } from '@/components/ui/Switch';
import { toast } from '@/state/toast';
import { useConfig } from './AccountCard';
import { fieldClass, groupClass, SectionHeader, Skeleton, useHydrated } from './WorldCard';

const EXPLAINER = 'Keep your worlds’ code in your own GitHub repositories. Orb keeps its copy either way.';
const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo&description=Orb%20worlds';

/**
 * Finish the OAuth round-trip: if the URL hash carries `gh_token=…` or `gh_error=…` (set by
 * /api/github/callback), strip it from the address bar and hand the token to Orb. The app shell
 * calls it on startup.
 */
export function consumeGitHubTokenFromHash(): Promise<GitHubConnection | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = params.get('gh_token');
  const failure = params.get('gh_error');
  if (!token && !failure) return Promise.resolve(null);
  params.delete('gh_token');
  params.delete('gh_error');
  const rest = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);
  if (!token) {
    if (failure !== 'access_denied') toast('Couldn’t connect GitHub. Please try again.', 'error');
    return Promise.resolve(null);
  }
  return api
    .connectGitHub(token)
    .then((c) => {
      toast(`GitHub connected as @${c.login}`, 'success');
      window.dispatchEvent(new Event('orb:github'));
      return c;
    })
    .catch((e) => {
      console.warn('[orb] GitHub OAuth token rejected', e);
      toast('Couldn’t connect GitHub. Please try again.', 'error');
      return null;
    });
}

/**
 * A token this browser kept from before Orb kept them (`orb:github`, with its "save every world"
 * switch) goes to Orb once, so that browser's worlds stay on GitHub.
 */
export async function moveBrowserToken(): Promise<void> {
  const old = readJSON<{ token?: unknown; autoSync?: unknown } | null>('orb:github', null);
  if (!old) return;
  try {
    if (typeof old.token === 'string' && old.token) {
      await api.connectGitHub(old.token);
      if (old.autoSync !== false) await api.keepWorldsOnGitHub(true);
      window.dispatchEvent(new Event('orb:github'));
    }
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 400) return;
  }
  localStorage.removeItem('orb:github');
  localStorage.removeItem('orb:gh-repos');
}

export function GitHubConnect() {
  const hydrated = useHydrated();
  return (
    <section aria-labelledby="orb-gh-h">
      <SectionHeader id="orb-gh-h" title="GitHub" hint={EXPLAINER} />
      {hydrated ? <GitHubConnectInner /> : <Skeleton className="h-[64px] rounded-[18px]" />}
    </section>
  );
}

function GitHubConnectInner() {
  const [conn, setConn] = useState<GitHubConnection | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const { config, status } = useConfig();

  useEffect(() => {
    const load = () => api.github().then((r) => setConn(r.login ? r : null), () => setConn(null));
    load();
    window.addEventListener('orb:github', load);
    return () => window.removeEventListener('orb:github', load);
  }, []);

  const change = async (run: () => Promise<GitHubConnection | null>) => {
    setBusy(true);
    try {
      setConn(await run());
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t change that. Please try again.', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (conn === undefined || (!conn && (status === 'idle' || status === 'loading'))) return <Skeleton className="h-[64px] rounded-[18px]" />;

  if (conn) {
    return (
      <div className={`${groupClass} p-1.5`}>
        <div className="flex items-center gap-3 px-2.5 py-2">
          <Avatar name={conn.login} size={34} color="#24292f" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium text-ink">@{conn.login}</div>
            <div className="flex items-center gap-1 text-[12.5px] text-ink-2">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--ok)]" aria-hidden="true" />
              Connected
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="-mr-1"
            disabled={busy}
            onClick={() =>
              void change(async () => {
                await api.disconnectGitHub();
                toast('GitHub disconnected');
                return null;
              })
            }
          >
            Disconnect
          </Button>
        </div>
        <div className="mx-2.5 h-px bg-[color-mix(in_oklab,var(--ink)_7%,transparent)]" />
        <label className="flex cursor-pointer items-center gap-3 px-2.5 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] text-ink">Keep every world on GitHub</span>
            <span className="block text-[12.5px] leading-snug text-ink-2">Each world gets a private repository, and every new version is a commit.</span>
          </span>
          <Switch checked={conn.auto} disabled={busy} onChange={(v) => void change(() => api.keepWorldsOnGitHub(v))} label="Keep every world on GitHub" />
        </label>
      </div>
    );
  }

  if (config?.githubOAuth) {
    return (
      // A route handler that redirects to GitHub: a full navigation, not a client-side one.
      // eslint-disable-next-line @next/next/no-html-link-for-pages
      <a
        href="/api/github/login"
        className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-ink px-4 text-[14px] font-medium text-paper shadow-[0_6px_20px_-6px_rgba(12,12,20,.45)] transition-[transform,opacity] duration-200 ease-[var(--ease)] hover:opacity-90 focus-visible:rounded-full active:scale-[.97]"
      >
        <Icon name="github" size={17} />
        Connect GitHub
      </a>
    );
  }

  return <TokenForm onConnected={setConn} />;
}

function TokenForm({ onConnected }: { onConnected(c: GitHubConnection): void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const submit = async () => {
    const t = token.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      const c = await api.connectGitHub(t);
      onConnected(c);
      setToken('');
      toast(`GitHub connected as @${c.login}`, 'success');
    } catch (e) {
      console.warn('[orb] GitHub token rejected', e);
      setError('That token didn’t work. Make sure it can create and write repositories.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={`${groupClass} p-3`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="mb-1.5 flex items-baseline justify-between px-0.5">
        <label htmlFor={id} className="text-[12.5px] font-medium text-ink-2">
          Paste a token
        </label>
        <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-[12.5px] text-ink-2 underline-offset-2 hover:text-ink hover:underline">
          Create one on GitHub
          <Icon name="external" size={11} />
        </a>
      </div>
      <div className="flex gap-2">
        <input
          id={id}
          type="password"
          className={`${fieldClass} font-mono text-[13px]`}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setError(null);
          }}
          placeholder="ghp_… or github_pat_…"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          disabled={busy}
        />
        <Button type="submit" variant="primary" disabled={!token.trim() || busy} className="shrink-0">
          {busy ? <Spinner size={15} /> : 'Connect'}
        </Button>
      </div>
      {error ? (
        <p id={`${id}-err`} role="alert" className="mt-2 px-0.5 text-[12.5px] text-[var(--bad)]">
          {error}
        </p>
      ) : (
        <p className="mt-2 flex gap-1.5 px-0.5 text-[12px] leading-snug text-ink-3">
          <Icon name="lock" size={13} className="mt-[1px] shrink-0" />
          Orb keeps it sealed and only uses it for your worlds’ repositories.
        </p>
      )}
    </form>
  );
}
