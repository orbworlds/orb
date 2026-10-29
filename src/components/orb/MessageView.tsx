'use client';
// One chat message. User → a compact soft bubble on the right. Orb → warm text with a tiny orb
// avatar, in the order it streamed: what it said first, the build as a minimalist checklist, what it
// said after; then Undo (the newest reply that changed the world) and suggestion chips, or Remix
// when a visitor asked for a change.
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { sentPhotos } from '@/lib/photos';
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

interface MessageViewProps {
  message: ChatMessage;
  /** This is the newest message in the thread (suggestions + countdown show only here). */
  isLast: boolean;
  /** A build is running somewhere in this chat (hides chips / undo meanwhile). */
  building: boolean;
  /** Someone else's world: Orb answers here ("Thinking…") rather than builds ("Building…"). */
  guide: boolean;
  /** The newest reply that changed the world, in a world you can change. */
  canUndo: boolean;
  retryAfter: number | null;
  onUndo(id: string): void;
  onSuggest(text: string): void;
  onOpenKeys(): void;
  /** Someone else's world: remix it and build what this answer couldn't change here. */
  onRemix?(): void;
  /** This answer failed: ask the same again. */
  onRetry?(): void;
}

export function MessageView(props: MessageViewProps) {
  const { message } = props;
  if (message.role === 'user') {
    return (
      <div className="animate-fade-up flex flex-col items-end gap-1.5 pl-10">
        {!!message.photos?.length && <SentPhotos id={message.id} photos={message.photos} />}
        {message.text && (
          <div className="max-w-full rounded-[18px] rounded-br-[6px] bg-[var(--bubble)] px-3.5 py-2 text-[14.5px] leading-[1.45] break-words whitespace-pre-wrap text-ink">
            {message.text}
          </div>
        )}
      </div>
    );
  }
  return <AssistantMessage {...props} />;
}

/** The photos a message was sent with: one shows large, several as tiles; a click shows one up close. */
function SentPhotos({ id, photos }: { id: string; photos: string[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const one = photos.length === 1;
  return (
    <>
      <ul className="flex flex-wrap justify-end gap-1.5" aria-label={one ? 'Photo' : `${photos.length} photos`}>
        {photos.map((src, i) => (
          <li key={i}>
            <button type="button" onClick={() => setOpen(i)} aria-label={`Show photo ${i + 1}`} className="block overflow-hidden rounded-[16px] rounded-br-[6px] focus-visible:rounded-[16px]">
              {/* eslint-disable-next-line @next/next/no-img-element -- a small data URL kept with the chat */}
              <img src={src} alt="" className={one ? 'max-h-[220px] max-w-[220px] object-cover' : 'h-24 w-24 object-cover'} />
            </button>
          </li>
        ))}
      </ul>
      {open !== null && <PhotoViewer src={sentPhotos(id)?.[open] ?? photos[open]} onClose={() => setOpen(null)} />}
    </>
  );
}

/** One photo over everything; a click anywhere or Esc closes it. */
function PhotoViewer({ src, onClose }: { src: string; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Photo" onClick={onClose} className="animate-fade-in fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      {/* eslint-disable-next-line @next/next/no-img-element -- a data URL from this chat */}
      <img src={src} alt="" className="max-h-full max-w-full rounded-[14px] object-contain shadow-[0_20px_60px_rgba(0,0,0,.5)]" />
      <button type="button" onClick={onClose} aria-label="Close" className="absolute top-[calc(var(--safe-t)+12px)] right-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25">
        <Icon name="x" size={18} />
      </button>
    </div>,
    document.body,
  );
}

function AssistantMessage({ message, isLast, building, guide, canUndo, retryAfter, onUndo, onSuggest, onOpenKeys, onRemix, onRetry }: MessageViewProps) {
  const b = message.build;
  const streaming = b?.status === 'streaming';
  if (streaming) liveIds.add(message.id);
  const animate = liveIds.has(message.id);
  const steps = b?.steps ?? [];
  // What was said before the first step goes above the checklist, the rest under it.
  const at = steps.length ? (b?.stepsAt ?? message.text.length) : message.text.length;
  const before = message.text.slice(0, at).trim();
  const after = message.text.slice(at).trim();
  const thinking = streaming && !before && !after && !steps.length;
  const settled = isLast && !building && !streaming && !b?.undone;
  const remix = settled && b?.remix && onRemix;

  // An undone reply fades back, under the line that says so.
  const dim = `transition-opacity duration-300 ${b?.undone ? 'opacity-45' : ''}`;

  return (
    <div className="animate-fade-up flex gap-2.5 pr-2">
      <span className={`mt-[3px] shrink-0 ${dim}`}>
        <OrbSphere size={18} building={streaming} glow={false} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={dim}>
          {thinking && <Thinking label={guide ? 'Thinking…' : 'Building…'} since={b?.thinkingSince} />}
          {before && <Prose text={before} />}
          {steps.length > 0 && <Checklist build={b!} animate={animate} />}
          {after && <Prose text={after} className={steps.length ? 'mt-2.5' : ''} />}
          {streaming && b?.thought && (
            <p key={b.thought} className="animate-fade-in mt-2 line-clamp-2 text-[12.5px] leading-snug text-ink-3 italic">
              {b.thought}
            </p>
          )}
        </div>
        {b && <Status build={b} isLast={isLast} retryAfter={retryAfter} onOpenKeys={onOpenKeys} onRetry={isLast && !building ? onRetry : undefined} />}
        {b && <Footer build={b} id={message.id} canUndo={canUndo && !building} onUndo={onUndo} />}
        {/* A change they can't make here: the one way on, Remix (it builds the request in the copy). */}
        {remix ? (
          <button type="button" onClick={onRemix} className={`mt-3 gap-1.5 font-medium ${CHIP}`}>
            <Icon name="remix" size={14} /> Remix
          </button>
        ) : (
          settled && !!b?.suggestions?.length && <Chips items={b.suggestions} onPick={onSuggest} className="mt-3" />
        )}
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
      {since && s >= 5 && <span className="text-[13px] text-ink-3 tabular-nums">{formatCountdown(s)}</span>}
    </p>
  );
}

/** Narration: paragraphs on blank lines, single line breaks kept. */
function Prose({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`space-y-2 text-[14.5px] leading-[1.55] text-ink [overflow-wrap:anywhere] ${className}`}>
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
const ACCOUNT_HINT = /you → account/i;
const LINK = 'inline-flex h-7 items-center gap-1 font-medium text-ink underline decoration-ink-4 underline-offset-[3px] hover:decoration-ink';
/** The buttons under an error point the way, so its own pointers ("in You → Model", "(You → Account)") go. */
const unpoint = (s: string) => s.replace(/\s*\(You → \w+\)/g, '').replace(/\s+(?:in|via) You → \w+/g, '');

function Status({ build, isLast, retryAfter, onOpenKeys, onRetry }: { build: BuildInfo; isLast: boolean; retryAfter: number | null; onOpenKeys(): void; onRetry?(): void }) {
  if (build.status === 'stopped') {
    return <p className="mt-2 text-[12.5px] text-ink-3">Stopped{build.steps.some((s) => s.status === 'done') ? ' — kept what was finished' : ''}.</p>;
  }
  if (build.status !== 'error' || !build.error) return null;
  if (build.errorCode === 'out_of_credits') return <OutOfCredits message={build.error} onOpenKeys={onOpenKeys} />;
  const countdown = isLast && retryAfter != null && retryAfter > 0;
  const account = ACCOUNT_HINT.test(build.error);
  const key = countdown || KEY_HINT.test(build.error);
  return (
    <div className="mt-2.5 rounded-[14px] bg-[var(--warn-bg)] px-3.5 py-2.5 text-[13.5px] leading-[1.45] text-ink" role="status">
      <p>{unpoint(build.error)}</p>
      {onRetry && !countdown && (
        <button type="button" onClick={onRetry} className={`mt-1.5 text-[13px] ${LINK}`}>
          <Icon name="refresh" size={13} /> Try again
        </button>
      )}
      {(account || key) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          {countdown && (
            <span className="text-ink-2">
              Free building resumes in <span className="font-medium text-ink tabular-nums">{formatCountdown(retryAfter!)}</span>
            </span>
          )}
          {account && (
            <button type="button" onClick={() => useUi.getState().requestSignup()} className={LINK}>
              Create a free account
            </button>
          )}
          {key && (
            <button type="button" onClick={onOpenKeys} className={LINK}>
              <Icon name="key" size={13} /> Use your own key
            </button>
          )}
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
  return (
    <div className="mt-2.5 rounded-[14px] bg-[color-mix(in_oklab,var(--iris-1)_10%,transparent)] px-3.5 py-3 text-[13.5px] leading-[1.45] text-ink" role="status">
      <p className="flex gap-2">
        <Icon name="coins" size={15} className="mt-[2px] shrink-0 text-[var(--iris-1)]" />
        <span>{unpoint(message)}</span>
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
        <button type="button" onClick={() => ui.setPlans(true)} className={LINK}>
          See plans
        </button>
        {plan !== 'guest' && (
          <button type="button" onClick={onOpenKeys} className={LINK}>
            <Icon name="key" size={13} /> Use your own key
          </button>
        )}
      </div>
    </div>
  );
}

/** Undo under the newest reply that changed the world; an undone reply says where the world went. */
function Footer({ build, id, canUndo, onUndo }: { build: BuildInfo; id: string; canUndo: boolean; onUndo(id: string): void }) {
  if (build.undone) return <p className="mt-2 text-[12.5px] text-ink-2">Back to how it was</p>;
  if (!canUndo || build.fromVersion == null || build.toVersion == null || build.status === 'streaming') return null;
  return (
    <p className="mt-1.5 text-[12.5px]">
      <button type="button" onClick={() => onUndo(id)} className="-mx-2 inline-flex h-8 items-center gap-1 rounded-full px-2 font-medium text-ink-2 transition-colors hover:text-ink phone:-my-1.5 phone:h-11">
        <Icon name="undo" size={13} /> Undo
      </button>
    </p>
  );
}

const CHIP =
  'inline-flex min-h-8 items-center rounded-full bg-[var(--chip-bg)] px-3 py-1 text-left phone:min-h-11 phone:px-3.5 text-[13px] leading-tight text-ink shadow-[inset_0_0_0_1px_var(--ink-5),0_1px_2px_rgba(16,16,40,.05)] transition-[background,transform,box-shadow] duration-200 hover:bg-[var(--chip-bg-hover)] hover:shadow-[inset_0_0_0_1px_var(--ink-4),0_4px_12px_-4px_rgba(16,16,40,.16)] active:scale-[.97]';

/** Tappable suggestion chips (tap = send). */
export function Chips({ items, onPick, className = '' }: { items: string[]; onPick(text: string): void; className?: string }) {
  return (
    <div className={`flex flex-wrap gap-1.5 phone:gap-2 ${className}`}>
      {items.slice(0, 4).map((s) => (
        <button key={s} type="button" onClick={() => onPick(s)} className={CHIP}>
          {s}
        </button>
      ))}
    </div>
  );
}
