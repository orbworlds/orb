'use client';
// The Chat tab: the conversation (pinned to the newest message unless the reader scrolls up), a
// first line that fits the world on screen, and the composer; with two or more chats, a row above
// to switch between them.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { track } from '@/lib/analytics';
import type { UseBuild } from '@/lib/engine/useBuild';
import type { Photo } from '@/lib/photos';
import { getModelSettings } from '@/lib/local';
import { TEMPLATE_BY_ID } from '@/lib/templates';
import { creditsText, useCredits } from '@/state/billing';
import { trackPrompt } from '@/state/tracking';
import { useIsMobile, useUi } from '@/state/ui';
import { CHANGE_CHIPS, useWorld } from '@/state/world';
import { ChatSwitcher } from './ChatSwitcher';
import { Composer } from './Composer';
import { Chips, formatCountdown, MessageView } from './MessageView';
import { OrbSphere } from './Orb';
import { PlayWhileBuilding } from './PlayWhileBuilding';
import { StartFrom } from './StartFrom';

const VISITOR_CHIPS = ['How do I play?', 'What can I do here?'];

export function ChatView({
  build,
  onOpenKeys,
  onOpenWorld,
  onMakeOwn,
  onRemix,
  onStartFrom,
  catchDrops,
}: {
  build: UseBuild;
  onOpenKeys(): void;
  onOpenWorld(worldId: string): void;
  /** In a world on its maker's site: start a world of one's own from this text (and photos). */
  onMakeOwn(text: string, photos: Photo[]): void;
  /** Remix the world on screen, then build `request` in the copy. */
  onRemix(request?: string): void;
  /** Start a new world as a remix of this one. */
  onStartFrom(worldId: string): void;
  /** Pictures dropped on the page come to this chat (everywhere but the home page's own box). */
  catchDrops: boolean;
}) {
  const { world, canEdit, chatKey, templateId, isExternal, verified } = useWorld();
  const { draft, setDraft, draftPhotos, setDraftPhotos, intro, focusSeq, detent, setDetent, panelOpen, tab } = useUi();
  const mobile = useIsMobile();
  const { messages, threads, threadId, isBuilding, retryAfter } = build;

  // --- pinned to the newest message ---------------------------------------------------------
  // Only the reader scrolling up lets go of it (new content, or the sheet or the keyboard resizing
  // the chat, never does); scrolling back down to it takes it again.
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) stick.current = true;
    else if (el.scrollTop < lastTop.current - 1) stick.current = false;
    lastTop.current = el.scrollTop;
    setAway(!stick.current);
  };

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
    });
    if (content.current) ro.observe(content.current);
    if (scroller.current) ro.observe(scroller.current);
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
    // A suggestion is words alone; what the composer sends takes its photos along.
    const photos = where === 'chat' ? draftPhotos : [];
    if ((!t && !photos.length) || isBuilding || confirming) return;
    setDraft('');
    if (photos.length) setDraftPhotos([]);
    if (isExternal) return onMakeOwn(t, photos);
    trackPrompt(where, t);
    stick.current = true;
    if (mobile) setDetent('half'); // keep the world visible while it gets built
    void build.send(t, photos);
  };

  const suggest = (text: string) => send(text, 'suggestion');

  const undo = (id: string) => {
    track('build_undo');
    build.undo(id).catch(() => {
      /* the store already told the user */
    });
  };

  const freeTier = getModelSettings().provider === 'free';
  const blocked = confirming
    ? 'Loading this world…'
    : retryAfter != null && retryAfter > 0 && freeTier
      ? `Free building resumes in ${formatCountdown(retryAfter)}`
      : null;

  const visitor = !!world && !canEdit;
  const forkable = !!world?.forkable && !isExternal;
  const template = templateId && templateId !== 'blank' ? TEMPLATE_BY_ID[templateId] : undefined;
  const placeholder = isExternal ? 'Describe a world of your own…' : visitor ? `Ask about ${world.name}…` : world || template ? 'Describe a change…' : 'Describe a world to make…';

  const lastIndex = messages.length - 1;
  // Undo: on the newest reply that changed the world.
  const lastChange = canEdit ? messages.findLast((m) => m.build?.toVersion != null) : undefined;
  const showIntro = !!intro && intro.chatKey === chatKey;
  const empty = messages.length === 0;
  // A build that takes a while: games to play meanwhile (it keeps going in the background).
  const playSince = isBuilding && canEdit && messages[lastIndex]?.role === 'assistant' ? messages[lastIndex].createdAt : null;

  return (
    <>
      {threads.length > 1 && !(mobile && detent === 'half') && (
        <ChatSwitcher
          threads={threads}
          threadId={threadId}
          chatKey={chatKey}
          canStartNew={!empty && !isBuilding}
          onSwitch={build.switchThread}
          onNew={build.newThread}
          onOpenOther={(worldId) => {
            track('world_open', { world_id: worldId, source: 'chat' });
            onOpenWorld(worldId);
          }}
        />
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Soft fades where the conversation meets the rows above and the composer. */}
        <div
          ref={scroller}
          onScroll={onScroll}
          className="scroll-soft min-h-0 flex-1 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,#000_16px,#000_calc(100%_-_20px),transparent)]"
        >
          <div ref={content} className="flex min-h-full flex-col justify-end gap-5 px-4 pt-4 pb-5">
            {showIntro && <OrbLine text={intro!.text} chips={empty ? intro!.suggestions : undefined} onPick={suggest} />}
            {!showIntro && empty && <EmptyState world={world} visitor={visitor} isExternal={isExternal} template={template} onPick={suggest} onStartFrom={onStartFrom} />}
            {messages.map((m, i) => (
              <MessageView
                key={m.id}
                message={m}
                isLast={i === lastIndex}
                building={isBuilding}
                guide={visitor}
                canUndo={m === lastChange}
                retryAfter={retryAfter}
                onUndo={undo}
                onSuggest={suggest}
                onOpenKeys={onOpenKeys}
                onRemix={visitor && forkable && i === lastIndex ? () => onRemix(messages[i - 1]?.role === 'user' ? messages[i - 1].text : undefined) : undefined}
                onRetry={() => void build.retry(m.id)}
              />
            ))}
            {playSince != null && <PlayWhileBuilding key={playSince} since={playSince} worldId={world?.id} onOpen={onOpenWorld} />}
          </div>
        </div>
        <button
          type="button"
          aria-label="Jump to the latest message"
          onClick={() => {
            stick.current = true;
            toBottom(true);
          }}
          className={`glass-strong absolute right-3 bottom-3 flex h-9 w-9 items-center justify-center rounded-full text-ink-2 transition-[opacity,transform] duration-300 ease-[var(--ease)] hover:text-ink phone:h-11 phone:w-11 ${away ? 'opacity-100' : 'pointer-events-none translate-y-2 opacity-0'}`}
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
          photos={draftPhotos}
          onPhotos={setDraftPhotos}
          catchDrops={catchDrops}
          onDropped={() => (!panelOpen || tab !== 'chat') && useUi.getState().openPanel('chat')}
        />
      </div>
    </>
  );
}

/** Credits running low (less than a typical build) or out, with the way to more (accounts only). */
function CreditsNote() {
  const { info } = useCredits();
  if (!info || info.plan === 'guest' || info.credits.left >= info.plans.typicalBuild) return null;
  const out = info.credits.left < 1;
  return (
    <p className="animate-fade-up flex flex-wrap items-center gap-x-1.5 px-2 pb-1.5 text-[12.5px] text-ink-2" role="status">
      <span className="tabular-nums">{out ? 'You’re out of credits' : `${creditsText(info.credits.left)} left`}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="font-medium text-ink underline decoration-ink-4 underline-offset-[3px] hover:decoration-ink" onClick={() => useUi.getState().setPlans(true)}>
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
  isExternal,
  template,
  onPick,
  onStartFrom,
}: {
  world: ReturnType<typeof useWorld.getState>['world'];
  visitor: boolean;
  isExternal: boolean;
  template?: (typeof TEMPLATE_BY_ID)[string];
  onPick(t: string): void;
  onStartFrom(worldId: string): void;
}) {
  if (!world && !template) {
    return (
      <OrbLine text="What should we make?" chips={TEMPLATE_BY_ID.blank.suggestions} onPick={onPick}>
        <StartFrom onStart={onStartFrom} />
      </OrbLine>
    );
  }
  if (world && isExternal) return <OrbLine text={`${world.name} runs on its maker's site, so I can't look inside it. Describe a world of your own and I'll make it.`} onPick={onPick} />;
  if (world && visitor) return <OrbLine text={`You’re in ${world.name}${world.authorName ? ` by ${world.authorName}` : ''}. Ask me anything about it.`} chips={VISITOR_CHIPS} onPick={onPick} />;
  return <OrbLine text="What should we change?" chips={template?.suggestions ?? CHANGE_CHIPS} onPick={onPick} />;
}
