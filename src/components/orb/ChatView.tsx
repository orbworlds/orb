'use client';
// The Chat tab: thread switcher, the conversation (auto-scroll that respects scrolling up), a
// context-aware empty state, and the composer.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { track } from '@/lib/analytics';
import type { UseBuild } from '@/lib/engine/useBuild';
import { getModelSettings } from '@/lib/local';
import { TEMPLATE_BY_ID } from '@/lib/templates';
import { creditsText, useCredits } from '@/state/billing';
import { trackPrompt } from '@/state/tracking';
import { useIsMobile, useUi } from '@/state/ui';
import { useWorld } from '@/state/world';
import { ChatSwitcher } from './ChatSwitcher';
import { Composer } from './Composer';
import { Chips, formatCountdown, MessageView } from './MessageView';
import { OrbSphere } from './Orb';
import { StartFrom } from './StartFrom';

const OWNER_CHIPS = ['Make it nighttime', 'Add gentle music', 'Add a little surprise'];

export function ChatView({
  build,
  onOpenKeys,
  onOpenWorld,
  onMakeLikeThis,
  onRemix,
  onStartFrom,
}: {
  build: UseBuild;
  onOpenKeys(): void;
  onOpenWorld(worldId: string, threadId: string): void;
  onMakeLikeThis(): void;
  /** Make the viewer's own copy of the world on screen, then build `request` there (if given). */
  onRemix(request?: string): void;
  /** Start a new world as a remix of this one. */
  onStartFrom(worldId: string): void;
}) {
  const { world, canEdit, chatKey, templateId, isExternal, verified } = useWorld();
  const { draft, setDraft, intro, focusSeq, setDetent, panelOpen } = useUi();
  const mobile = useIsMobile();
  const { messages, threads, threadId, isBuilding, retryAfter } = build;

  // --- auto-scroll: follow new content unless the reader scrolled up ----------------------------
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = atBottom;
    setAway(!atBottom);
  };

  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  // A different thread (or reopening the panel) starts at the newest message.
  useLayoutEffect(() => {
    stick.current = true;
    setAway(false);
    toBottom();
  }, [threadId, panelOpen, toBottom]);

  // Until the API confirms who may edit (the server-rendered copy is public-only and has no code),
  // a change would be built against nothing — and an owner's own world would get forked.
  const confirming = !!world && !verified;

  // --- sending -------------------------------------------------------------------------------
  const send = (text: string, where: 'chat' | 'suggestion' = 'chat') => {
    const t = text.trim();
    if (!t || isBuilding || confirming) return;
    trackPrompt(where, t);
    setDraft('');
    stick.current = true;
    if (mobile) setDetent('half'); // keep the world visible while it gets built
    void build.send(t);
  };

  const suggest = (text: string) => send(text, 'suggestion');

  const undo = useCallback(
    (id: string) => {
      track('build_undo');
      build.undo(id).catch(() => {
        /* the store already told the user */
      });
    },
    [build],
  );

  const freeTier = (getModelSettings().provider ?? 'free') === 'free';
  const blocked = confirming
    ? 'Loading this world…'
    : retryAfter != null && retryAfter > 0 && freeTier
      ? `Free building resumes in ${formatCountdown(retryAfter)}`
      : null;

  const visitor = !!world && !canEdit;
  const forkable = !!world?.forkable && !isExternal;
  const placeholder = !world ? 'Describe your world…' : isExternal ? 'Ask about this world…' : canEdit ? 'Describe a change…' : forkable ? 'Ask, or describe a change…' : 'Ask about this world…';

  const lastIndex = messages.length - 1;
  const showIntro = !!intro && intro.chatKey === chatKey;
  const empty = messages.length === 0;

  return (
    <>
      {(messages.length > 0 || threads.length > 1) && <ChatSwitcher
        threads={threads}
        threadId={threadId}
        chatKey={chatKey}
        canStartNew={!empty && !isBuilding}
        onSwitch={build.switchThread}
        onNew={build.newThread}
        onOpenOther={(worldId, id) => {
          track('world_open', { world_id: worldId, source: 'chat' });
          onOpenWorld(worldId, id);
        }}
      />}
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="scroll-soft absolute inset-0 overflow-y-auto overscroll-contain">
          <div ref={content} className="flex min-h-full flex-col justify-end gap-5 px-4 pt-3 pb-4">
            {showIntro && <OrbLine text={intro!.text} chips={empty ? intro!.suggestions : undefined} onPick={suggest} />}
            {!showIntro && empty && (
              <EmptyState
                world={world}
                visitor={visitor}
                forkable={forkable}
                isExternal={isExternal}
                templateId={templateId}
                onPick={suggest}
                onMakeLikeThis={onMakeLikeThis}
                onRemix={() => onRemix()}
                onStartFrom={onStartFrom}
              />
            )}
            {messages.map((m, i) => (
              <MessageView
                key={m.id}
                message={m}
                isLast={i === lastIndex}
                building={isBuilding}
                canUndo={!!world && canEdit}
                retryAfter={retryAfter}
                onUndo={undo}
                onSuggest={suggest}
                onOpenKeys={onOpenKeys}
                onRemix={visitor && forkable && i === lastIndex ? () => onRemix(messages[i - 1]?.role === 'user' ? messages[i - 1].text : undefined) : undefined}
              />
            ))}
          </div>
        </div>
        {/* Soft fade where the conversation meets the composer. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-[var(--glass-bg-strong)] to-transparent" />
        <button
          type="button"
          aria-label="Jump to the latest message"
          onClick={() => {
            stick.current = true;
            toBottom(true);
          }}
          className={`glass-strong absolute bottom-3 left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full text-ink-2 transition-[opacity,transform] duration-300 ease-[var(--ease)] hover:text-ink ${away ? 'opacity-100' : 'pointer-events-none translate-y-2 opacity-0'}`}
          tabIndex={away ? 0 : -1}
        >
          <Icon name="chevron-down" size={18} />
        </button>
      </div>
      <div className="shrink-0 px-3 pt-1 pb-3">
        {freeTier && <CreditsNote />}
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={send}
          onStop={build.stop}
          building={isBuilding}
          blocked={blocked}
          placeholder={placeholder}
          focusSignal={focusSeq}
          id="orb-composer"
        />
      </div>
    </>
  );
}

/** Credits running low (less than a typical build) or out, with the way to more (accounts only). */
function CreditsNote() {
  const { info } = useCredits();
  const ui = useUi();
  if (!info || info.plan === 'guest' || info.credits.left >= info.plans.typicalBuild) return null;
  const out = info.credits.left < 1;
  return (
    <p className="animate-fade-up flex flex-wrap items-center gap-x-1.5 px-2 pb-1.5 text-[12.5px] text-ink-2" role="status">
      <span className="tabular-nums">{out ? 'You’re out of credits' : `${creditsText(info.credits.left)} left`}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="font-medium text-ink underline decoration-ink-4 underline-offset-[3px] hover:decoration-ink" onClick={() => ui.setPlans(true)}>
        {info.plan === 'pro' ? 'Top up' : 'See plans'}
      </button>
    </p>
  );
}

/** An Orb line without a stored message: avatar + text (+ chips). */
function OrbLine({ text, chips, onPick, children }: { text: string; chips?: string[]; onPick(t: string): void; children?: ReactNode }) {
  return (
    <div className="animate-fade-up flex gap-2.5 pr-2">
      <span className="mt-[3px] shrink-0">
        <OrbSphere size={18} glow={false} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] leading-[1.55] text-ink">{text}</p>
        {chips && chips.length > 0 && <Chips items={chips} onPick={onPick} className="mt-3" />}
        {children}
      </div>
    </div>
  );
}

function EmptyState({
  world,
  visitor,
  forkable,
  isExternal,
  templateId,
  onPick,
  onMakeLikeThis,
  onRemix,
  onStartFrom,
}: {
  world: ReturnType<typeof useWorld.getState>['world'];
  visitor: boolean;
  forkable: boolean;
  isExternal: boolean;
  templateId: string | null;
  onPick(t: string): void;
  onMakeLikeThis(): void;
  onRemix(): void;
  onStartFrom(worldId: string): void;
}) {
  const template = templateId ? TEMPLATE_BY_ID[templateId] : undefined;
  if (!world) {
    return (
      <OrbLine text="What shall we make? Describe it & watch it come alive." chips={(template ?? TEMPLATE_BY_ID.blank).suggestions} onPick={onPick}>
        <StartFrom onStart={onStartFrom} />
      </OrbLine>
    );
  }
  if (isExternal) {
    return (
      <OrbLine
        text={
          visitor
            ? `You're visiting ${world.name} by ${world.authorName}. This one can't be changed — but ask me anything about it, or let's make your own world like it.`
            : `${world.name} lives on its own site, so I can't change it here — but ask me anything about it, or let's make a new world like it.`
        }
        onPick={onPick}
      >
        {world.sourceUrl && (
          <a
            href={world.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 mr-2 inline-flex min-h-8 items-center gap-1.5 rounded-full bg-[var(--chip-bg)] px-3 py-1 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--ink-5)] hover:bg-[var(--chip-bg-hover)]"
          >
            <Icon name="github" size={14} /> See the code
          </a>
        )}
        <button
          type="button"
          onClick={onMakeLikeThis}
          className="mt-3 inline-flex min-h-8 items-center gap-1.5 rounded-full bg-[var(--chip-bg)] px-3 py-1 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--ink-5)] hover:bg-[var(--chip-bg-hover)]"
        >
          <Icon name="sparkle" size={14} /> Make something like this
        </button>
      </OrbLine>
    );
  }
  if (visitor) {
    return forkable ? (
      <OrbLine
        text={`You're visiting ${world.name} by ${world.authorName}. Ask me anything about it — or make your own copy to change it.`}
        chips={['How does it work?', 'What can I do here?']}
        onPick={onPick}
      >
        <button
          type="button"
          onClick={onRemix}
          className="mt-1.5 inline-flex min-h-8 items-center gap-1.5 rounded-full bg-[var(--chip-bg)] px-3 py-1 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--ink-5)] hover:bg-[var(--chip-bg-hover)]"
        >
          <Icon name="remix" size={14} /> Make my own copy
        </button>
      </OrbLine>
    ) : (
      <OrbLine text="Ask me anything about this world." chips={['How does it work?', 'What can I do here?']} onPick={onPick} />
    );
  }
  return <OrbLine text="What should we change?" chips={template && template.id !== 'blank' ? template.suggestions : OWNER_CHIPS} onPick={onPick} />;
}
