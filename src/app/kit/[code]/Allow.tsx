'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { OrbSphere } from '@/components/orb/Orb';

type View = 'ask' | 'busy' | 'done' | 'failed';

export default function Allow({ code }: { code: string }) {
  const router = useRouter();
  const [view, setView] = useState<View>('ask');
  const [problem, setProblem] = useState('');
  const [name, setName] = useState<string | null>(null);

  const allow = async () => {
    setView('busy');
    try {
      setName((await api.approveKit(code)).name);
      setView('done');
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'Orb couldn’t be reached. Try again.');
      setView('failed');
    }
  };

  const title = view === 'done' ? 'All set' : view === 'failed' ? 'That didn’t work' : 'Push worlds from your computer?';
  const text =
    view === 'done'
      ? `Your computer can push worlds to Orb${name ? ` as ${name}` : ''} now, and they’re yours here too. Head back to it: the push carries on by itself.`
      : view === 'failed'
        ? problem
        : 'The Orb kit on your computer (or your coding agent) is asking to put worlds on Orb as you. Allow it only if you just ran orb push.';

  return (
    <main className="sky fixed inset-0 flex items-center justify-center p-6">
      <div className="glass-strong animate-fade-up w-full max-w-[360px] rounded-[var(--r-panel)] px-7 pt-8 pb-7 text-center">
        <OrbSphere size={56} building={view === 'busy'} />
        <div aria-live="polite">
          <h1 className="font-display mt-5 text-[26px] leading-[1.15] text-balance">{title}</h1>
          <p className={`mt-2 text-[14px] leading-snug ${view === 'failed' ? 'text-[var(--bad)]' : 'text-ink-2'}`}>{text}</p>
        </div>
        {(view === 'ask' || view === 'busy') && (
          <>
            <p className="mt-4 font-mono text-[18px] tracking-[0.12em] text-ink" aria-label={`Code ${code.split('').join(' ')}`}>
              {code}
            </p>
            <p className="mt-1 text-[12.5px] text-ink-3">It should match the code your terminal shows.</p>
            <div className="mt-5 flex flex-col items-center gap-1">
              <Button variant="primary" onClick={allow} disabled={view === 'busy'}>
                {view === 'busy' ? <Spinner size={15} /> : <Icon name="check" size={16} />}
                Allow
              </Button>
              <Button variant="ghost" onClick={() => router.push('/')}>
                Not now
              </Button>
            </div>
          </>
        )}
        {(view === 'done' || view === 'failed') && (
          <div className="mt-5 flex justify-center">
            <Button variant={view === 'done' ? 'primary' : 'ghost'} onClick={() => router.push('/')}>
              Go to Orb
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
