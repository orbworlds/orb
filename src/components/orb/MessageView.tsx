'use client';
// One chat message. User → a compact soft bubble on the right. Orb → warm text with a tiny orb
// avatar, the build as a minimalist checklist, a "v12 · 14 credits · Undo" footer and suggestion chips.
import { Fragment, memo, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import type { BuildInfo, BuildStep, ChatMessage } from '@/lib/types';
import { useBilling } from '@/state/billing';
import { useUi } from '@/state/ui';
import { OrbSphere } from './Orb';

/** Messages seen streaming in this page view — only those animate their ticks. */
const liveIds = new Set<string>();

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export interface MessageViewProps {
  message: ChatMessage;
  /** This is the newest message in the thread (suggestions + countdown show only here). */
  isLast: boolean;
  /** A build is running somewhere in this chat (hides chips / undo meanwhile). */
  building: boolean;
  canUndo: boolean;
  retryAfter: number | null;
  onUndo(id: string): void;
  onSuggest(text: string): void;
  onOpenKeys(): void;
  /** Someone else's world: make their own copy and build what this answer couldn't change here. */
  onRemix?(): void;
}

export const MessageView = memo(function MessageView(props: MessageViewProps) {
  const { message } = props;
  if (message.role === 'user') {
    return (
      <div className="animate-fade-up flex justify-end pl-10" data-msg={message.id}>
        <div className="max-w-full rounded-[18px] rounded-br-[6px] bg-[var(--bubble)] px-3.5 py-2 text-[14.5px] leading-[1.45] break-words whitespace-pre-wrap text-ink">
          {message.text}
        </div>
      </div>
    );
  }
  return <AssistantMessage {...props} />;
});

function AssistantMessage({ message, isLast, building, canUndo, retryAfter, onUndo, onSuggest, onOpenKeys, onRemix }: MessageViewProps) {
  const b = message.build;
  const streaming = b?.status === 'streaming';
  if (streaming) liveIds.add(message.id);
  const animate = liveIds.has(message.id);
  const text = message.text.trim();
  const steps = b?.steps ?? [];
  const thinking = streaming && !text && !steps.length;

  return (
    <div className="animate-fade-up flex gap-2.5 pr-2" data-msg={message.id}>
      <span className="mt-[3px] shrink-0">
        <OrbSphere size={18} building={streaming} glow={false} />
      </span>
      <div className="min-w-0 flex-1">
        {thinking && <Thinking label={b?.repair ? 'Fixing a little thing…' : b?.thinkingSince ? 'Thinking it through…' : 'Dreaming it up…'} since={b?.thinkingSince} />}
        {text && <Prose text={text} />}
        {steps.length > 0 && <Checklist build={b!} animate={animate} />}
        {streaming && b?.thought && (
          <p key={b.thought} className="animate-fade-in mt-2 line-clamp-2 text-[12.5px] leading-snug text-ink-3 italic">💭 {b.thought}</p>
        )}
        {b?.repair && streaming && steps.length > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ink-3">
            <Icon name="wand" size={13} /> Polishing a few things…
          </p>
        )}
        {b && <Status build={b} isLast={isLast} retryAfter={retryAfter} onOpenKeys={onOpenKeys} />}
        {b && <Footer build={b} id={message.id} canUndo={canUndo && !building} onUndo={onUndo} />}
        {isLast && !building && b?.status !== 'streaming' && b?.remix && onRemix && (
          <button
            type="button"
            onClick={onRemix}
            className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-[13.5px] font-medium text-paper transition-transform duration-150 active:scale-[.97]"
          >
            <Icon name="remix" size={15} /> Make my own copy
          </button>
        )}
        {isLast && !building && b?.status !== 'streaming' && !!b?.suggestions?.length && <Chips items={b.suggestions} onPick={onSuggest} className="mt-3" />}
      </div>
    </div>
  );
}

function Thinking({ label, since }: { label: string; since?: number }) {
  // Big models can think for minutes before writing: show that time passes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  const s = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  return (
    <p className="flex h-[22px] items-center gap-2 text-[14.5px]">
      <span className="shimmer-text font-medium">{label}</span>
      {since && s >= 5 && <span className="text-[13px] text-ink-3 tabular-nums">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>}
    </p>
  );
}

/** Narration: paragraphs on blank lines, single line breaks kept. */
function Prose({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-[14.5px] leading-[1.55] text-ink [overflow-wrap:anywhere]">
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i} className="whitespace-pre-line">
          {p}
        </p>
      ))}
    </div>
  );
}

function Checklist({ build, animate }: { build: BuildInfo; animate: boolean }) {
  const fixed = !!build.repair && build.status === 'done';
  return (
    <ul className="mt-2.5 space-y-[3px]" aria-label="Build steps">
      {build.steps.map((s) => (
        <StepRow key={s.id} step={s} animate={animate} fixed={fixed} live={build.status === 'streaming'} />
      ))}
    </ul>
  );
}

function StepRow({ step, animate, fixed, live }: { step: BuildStep; animate: boolean; fixed: boolean; live: boolean }) {
  let icon: ReactNode;
  let label: ReactNode;
  if (step.status === 'pending') {
    icon = live ? <Spinner size={13} /> : <span className="h-[7px] w-[7px] rounded-full bg-ink-4" />;
    label = <span className={live ? 'shimmer-text font-medium' : 'text-ink-3'}>{step.label}</span>;
  } else if (step.status === 'done') {
    icon = <Tick animate={animate} />;
    label = <span className="text-ink-2">{step.label}</span>;
  } else {
    icon = (
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--warn-bg)] text-[var(--warn-ink)]">
        <span className="h-[5px] w-[5px] rounded-full bg-current" />
      </span>
    );
    label = (
      <span className="text-[var(--warn-ink)]">
        {step.label}
        <span className="ml-1.5 text-[12px] opacity-80">{fixed ? '· fixed automatically' : step.error && !/stopped/i.test(step.error) ? '· skipped' : ''}</span>
      </span>
    );
  }
  return (
    <li className="flex min-h-[22px] items-start gap-2.5 text-[13.5px] leading-[1.4]">
      <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
    </li>
  );
}

function Tick({ animate }: { animate: boolean }) {
  return (
    <span className={`flex h-4 w-4 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--ok)_16%,transparent)] text-[var(--ok)] ${animate ? 'tick-animate' : ''}`}>
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2.5 6.3l2.3 2.3L9.6 3.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

const KEY_HINT = /you → model|own (ai )?key/i;

function Status({ build, isLast, retryAfter, onOpenKeys }: { build: BuildInfo; isLast: boolean; retryAfter: number | null; onOpenKeys(): void }) {
  if (build.status === 'stopped') {
    return <p className="mt-2 text-[12.5px] text-ink-3">Stopped{build.steps.some((s) => s.status === 'done') ? ' — kept what was finished' : ''}.</p>;
  }
  if (build.status !== 'error' || !build.error) return null;
  if (build.errorCode === 'out_of_credits') return <OutOfCredits message={build.error} onOpenKeys={onOpenKeys} />;
  const countdown = isLast && retryAfter != null && retryAfter > 0;
  // The link below replaces the textual "in You → Model" pointer.
  const message = build.error.replace(/\s+(?:in|via) You → Model/gi, '');
  return (
    <div className="mt-2.5 rounded-[14px] bg-[var(--warn-bg)] px-3.5 py-2.5 text-[13.5px] leading-[1.45] text-ink" role="status">
      <p>{message}</p>
      {(countdown || KEY_HINT.test(build.error)) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          {countdown && (
            <span className="text-ink-2">
              Free building resumes in <span className="font-medium text-ink tabular-nums">{formatCountdown(retryAfter!)}</span>
            </span>
          )}
          <button type="button" onClick={onOpenKeys} className="inline-flex h-7 items-center gap-1 font-medium text-ink underline decoration-ink-4 underline-offset-[3px] hover:decoration-ink">
            <Icon name="key" size={13} /> Use your own key
          </button>
        </div>
      )}
    </div>
  );
}

/** Out of credits: the way on for this person's plan (an account, Pro, a top-up, their own key). */
function OutOfCredits({ message, onOpenKeys }: { message: string; onOpenKeys(): void }) {
  const info = useBilling((s) => s.info);
  const going = useBilling((s) => s.going);
  const plan = info?.plan ?? (/free account/i.test(message) ? 'guest' : 'free');
  const ui = useUi.getState();
  // The buttons below replace the textual pointers ("(You → Account)", "in You → Model"…).
  const text = message.replace(/\s*\(You → \w+\)/g, '').replace(/\s+in You → \w+/g, '');
  const link = 'inline-flex h-7 items-center gap-1 font-medium text-ink underline decoration-ink-4 underline-offset-[3px] hover:decoration-ink';
  return (
    <div className="mt-2.5 rounded-[14px] bg-[color-mix(in_oklab,var(--iris-1)_10%,transparent)] px-3.5 py-3 text-[13.5px] leading-[1.45] text-ink" role="status">
      <p className="flex gap-2">
        <Icon name="coins" size={15} className="mt-[2px] shrink-0 text-[var(--iris-1)]" />
        <span>{text}</span>
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-[23px] text-[13px]">
        {plan === 'guest' && (
          <Button variant="primary" size="sm" onClick={() => ui.requestSignup()}>
            Create a free account
          </Button>
        )}
        {plan === 'free' && info?.payments && (
          <Button variant="iris" size="sm" disabled={!!going} onClick={() => void useBilling.getState().checkout('pro', 'chat')}>
            {going === 'pro' && <Spinner size={13} />}
            Go Pro
          </Button>
        )}
        {plan === 'pro' && info?.payments && (
          <Button variant="primary" size="sm" icon="plus" onClick={() => ui.setPlans(true)}>
            Top up
          </Button>
        )}
        <button type="button" onClick={() => ui.setPlans(true)} className={link}>
          See plans
        </button>
        {plan !== 'guest' && (
          <button type="button" onClick={onOpenKeys} className={link}>
            <Icon name="key" size={13} /> Use your own key
          </button>
        )}
      </div>
    </div>
  );
}

/** Rounded up: credits left are shown rounded down, so what a build used and what's left add up. */
const creditsLabel = (n: number) => {
  const whole = Math.max(1, Math.ceil(n - 1e-9));
  return `${whole.toLocaleString('en-US')} credit${whole === 1 ? '' : 's'}`;
};

/** "v12 · 14 credits · Undo": what the build saved and what it used (a stopped build or an answer too). */
function Footer({ build, id, canUndo, onUndo }: { build: BuildInfo; id: string; canUndo: boolean; onUndo(id: string): void }) {
  const used = build.credits != null && build.credits > 0;
  if (build.toVersion == null && !build.undone && !used) return null;
  const undoable = canUndo && !build.undone && build.fromVersion != null && build.toVersion != null && build.status !== 'streaming';
  const parts: ReactNode[] = [];
  if (build.toVersion != null) parts.push(<span className="tabular-nums">v{build.toVersion}</span>);
  if (used)
    parts.push(
      <span className="tabular-nums" title="What this build’s AI cost, in credits (a credit is a cent of AI time)">
        {creditsLabel(build.credits!)}
        {build.status === 'streaming' ? ' so far' : ''}
      </span>,
    );
  if (undoable)
    parts.push(
      <button type="button" onClick={() => onUndo(id)} className="-mx-1 inline-flex h-6 items-center gap-1 rounded-full px-1 font-medium text-ink-2 hover:text-ink">
        <Icon name="undo" size={12} /> Undo
      </button>,
    );
  if (build.undone) parts.push(<span>Undone</span>);
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-3">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true">·</span>}
          {part}
        </Fragment>
      ))}
    </p>
  );
}

/** Tappable suggestion chips (tap = send). */
export function Chips({ items, onPick, className = '' }: { items: string[]; onPick(text: string): void; className?: string }) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {items.slice(0, 4).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="inline-flex min-h-8 items-center rounded-full bg-[var(--chip-bg)] px-3 py-1 text-left text-[13px] leading-tight text-ink shadow-[inset_0_0_0_1px_var(--ink-5),0_1px_2px_rgba(16,16,40,.05)] transition-[background,transform,box-shadow] duration-200 hover:bg-[var(--chip-bg-hover)] hover:shadow-[inset_0_0_0_1px_var(--ink-4),0_4px_12px_-4px_rgba(16,16,40,.16)] active:scale-[.97]"
        >
          {s}
        </button>
      ))}
    </div>
  );
}
