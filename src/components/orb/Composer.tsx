'use client';
// The message box. Auto-grows, Enter sends (Shift+Enter = newline, IME-safe), the send button
// turns into stop while building. Photos go with the words: the picture button (on a phone it
// offers the camera too), pasting, or dropping them on the page; they show above the words, each
// with a way to take it out. Two looks: 'hero' (big, frosted, ideas typed out in the placeholder's
// color, as a hint) and 'panel' (compact).
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { BUILD_LIMITS } from '@/lib/engine/prompt';
import { addPhotos, isPhotoFile, type Photo } from '@/lib/photos';
import { toast } from '@/state/toast';
import { useReducedMotion } from '@/state/ui';

interface ComposerProps {
  value: string;
  onChange(v: string): void;
  onSend(text: string): void;
  onStop?(): void;
  building?: boolean;
  placeholder: string;
  /** Rotating ideas typed out as the placeholder (hero): a hint, never mistaken for typed text. */
  ideas?: string[];
  /** Disables sending and explains why (e.g. "Free building resumes in 0:42"). */
  blocked?: string | null;
  variant?: 'hero' | 'panel';
  /** Changes → take focus. */
  focusSignal?: number;
  autoFocus?: boolean;
  id?: string;
  /** Photos going with the message, when this composer takes them. */
  photos?: Photo[];
  onPhotos?(photos: Photo[]): void;
  /** Pictures dropped anywhere on the page come here (the one composer in view does). */
  catchDrops?: boolean;
  /** Pictures were dropped (e.g. to bring this composer into view). */
  onDropped?(): void;
}

/** A drag that carries files. */
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

const MAX_H = { hero: 168, panel: 176 };

export function Composer({ value, onChange, onSend, onStop, building = false, placeholder, ideas, blocked, variant = 'panel', focusSignal, autoFocus, id, photos = [], onPhotos, catchDrops = false, onDropped }: ComposerProps) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const hero = variant === 'hero';
  const [focused, setFocused] = useState(false);
  const typed = useTypingIdeas(ideas, !value);

  // --- photos: read one batch at a time, each added to what's there when it starts -------------
  const [reading, setReading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const current = useRef(photos);
  useLayoutEffect(() => {
    current.current = photos;
  }, [photos]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const add = (files: File[]) => {
    if (!onPhotos || !files.length) return;
    setReading((n) => n + Math.min(files.length, BUILD_LIMITS.photos));
    queue.current = queue.current.then(async () => {
      const { photos: next, problem } = await addPhotos(current.current, files);
      current.current = next;
      onPhotos(next);
      setReading(0);
      if (problem) toast(problem);
    });
  };
  const dropped = useEffectEvent((files: File[]) => {
    onDropped?.();
    add(files);
  });
  const remove = (photoId: string) => onPhotos?.(photos.filter((p) => p.id !== photoId));

  // Pictures dragged over the page land here (a dropped file must never open in place of Orb).
  useEffect(() => {
    if (!catchDrops || !onPhotos) return;
    let depth = 0;
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      dropped([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [catchDrops, onPhotos]);

  // A pasted picture is added (pasted words stay words).
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onPhotos || e.clipboardData.getData('text/plain').trim()) return;
    const files = [...e.clipboardData.files].filter(isPhotoFile);
    if (!files.length) return;
    e.preventDefault();
    add(files);
  };

  // Auto-grow: measure the content height, cap it, scroll beyond.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = Math.min(el.scrollHeight, MAX_H[variant]);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > MAX_H[variant] ? 'auto' : 'hidden';
  }, [value, variant]);

  const firstSignal = useRef(focusSignal);
  useEffect(() => {
    if (focusSignal === undefined || focusSignal === firstSignal.current) return;
    const el = ta.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusSignal]);

  useEffect(() => {
    if (autoFocus && window.matchMedia('(pointer: fine)').matches) ta.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const canSend = (!!value.trim() || photos.length > 0) && !reading && !building && !blocked;
  const submit = () => {
    if (!canSend) return;
    onSend(value.trim());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const showIdeas = !value && !photos.length && !!ideas?.length && !blocked;
  const ph = blocked || (showIdeas ? '' : photos.length && !value ? 'Say what to do with it…' : placeholder);
  const tile = hero ? 'h-16 w-16' : 'h-14 w-14';

  return (
    <form
      onSubmit={onSubmit}
      className={
        hero
          ? `glass-strong relative flex items-end gap-2 rounded-[28px] py-2.5 pr-2.5 pl-2.5 transition-shadow duration-300 sm:py-3 sm:pr-3 sm:pl-3 ${focused || dragging ? 'shadow-[inset_0_0_0_1px_var(--glass-hairline),0_0_0_1px_color-mix(in_oklab,var(--iris-1)_35%,transparent),0_0_0_6px_color-mix(in_oklab,var(--iris-1)_10%,transparent),var(--shadow-soft)]' : ''}`
          : `relative flex items-end gap-1.5 rounded-[22px] bg-[var(--field-bg)] py-1.5 pr-1.5 pl-1.5 transition-[background,box-shadow] duration-200 ${focused || dragging ? 'bg-[var(--field-bg-focus)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--iris-1)_40%,transparent),0_0_0_4px_color-mix(in_oklab,var(--iris-1)_10%,transparent)]' : ''}`
      }
    >
      {onPhotos && (
        <>
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={photos.length + reading >= BUILD_LIMITS.photos}
            aria-label="Add photos"
            title="Add photos"
            className={`flex shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-[var(--hover)] hover:text-ink disabled:opacity-40 ${hero ? 'h-11 w-11' : 'h-[34px] w-[34px]'}`}
          >
            <Icon name="image" size={hero ? 21 : 18} />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              add([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </>
      )}
      <div className={`relative min-w-0 flex-1 ${hero ? 'py-[7px]' : 'py-[6px]'} ${onPhotos ? '' : hero ? 'pl-3 sm:pl-3' : 'pl-2.5'}`}>
        {(photos.length > 0 || reading > 0) && (
          <ul className="mb-2 flex flex-wrap gap-2" aria-label="Photos to send">
            {photos.map((p, i) => (
              <li key={p.id} className={`animate-pop relative shrink-0 ${tile}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made in this page */}
                <img src={p.thumb} alt={`Photo ${i + 1}`} className={`${tile} rounded-[12px] object-cover shadow-[inset_0_0_0_1px_var(--ink-5)]`} />
                <button
                  type="button"
                  onClick={() => remove(p.id)}
                  aria-label={`Remove photo ${i + 1}`}
                  className="absolute -top-1.5 -right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ink text-paper shadow-[0_0_0_2px_var(--paper)] transition-transform hover:scale-105"
                >
                  <Icon name="x" size={12} strokeWidth={2.4} />
                </button>
              </li>
            ))}
            {Array.from({ length: reading }, (_, i) => (
              <li key={`r${i}`} className={`flex shrink-0 items-center justify-center rounded-[12px] bg-[var(--field-bg-focus)] ${tile}`} aria-label="Adding a photo">
                <Spinner size={14} />
              </li>
            ))}
          </ul>
        )}
        {showIdeas && (
          <div aria-hidden="true" className={`pointer-events-none absolute inset-x-0 top-0 truncate text-ink-3 ${hero ? 'py-[7px] text-[17px] leading-[26px]' : 'py-[6px] text-[14.5px] leading-[22px]'}`}>
            {typed}
          </div>
        )}
        <textarea
          ref={ta}
          id={id}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={ph}
          aria-label={placeholder}
          enterKeyHint="send"
          spellCheck
          className={`block w-full resize-none bg-transparent text-ink outline-none placeholder:text-ink-3 focus-visible:outline-none ${hero ? 'text-[17px] leading-[26px]' : 'text-[14.5px] leading-[22px]'}`}
          style={{ overflowY: 'hidden' }}
        />
      </div>
      {building && onStop ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop building"
          title="Stop"
          className={`animate-pop flex shrink-0 items-center justify-center rounded-full bg-ink text-paper transition-transform active:scale-95 ${hero ? 'h-11 w-11' : 'h-[34px] w-[34px]'}`}
        >
          <span className="block h-[10px] w-[10px] rounded-[3px] bg-current" />
        </button>
      ) : (
        <SendButton size={hero ? 44 : 34} disabled={!canSend} />
      )}
    </form>
  );
}

/** Iridescent round send button with a soft glow; with nothing to send, a faded disc in either scheme. */
function SendButton({ size, disabled }: { size: number; disabled: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-label="Send"
      title="Send  ·  Enter"
      className="group relative flex shrink-0 items-center justify-center rounded-full text-white transition-[transform,color] duration-300 ease-[var(--ease)] enabled:hover:scale-105 enabled:active:scale-95 disabled:text-ink-3"
      style={{ width: size, height: size }}
    >
      <span aria-hidden="true" className="absolute inset-0 rounded-full bg-[var(--ink-5)] shadow-[inset_0_0_0_1px_var(--ink-5)]" />
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full transition-opacity duration-300 group-disabled:opacity-0"
        style={{ background: 'var(--iris)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.45), inset 0 -2px 6px rgba(80,60,200,.25)' }}
      />
      <span
        aria-hidden="true"
        className="absolute -inset-1 -z-10 rounded-full opacity-70 blur-[10px] transition-opacity duration-300 group-disabled:opacity-0"
        style={{ background: 'var(--iris)' }}
      />
      <Icon name="arrow-up" size={Math.round(size * 0.45)} strokeWidth={2.2} className="relative group-enabled:drop-shadow-[0_1px_1px_rgba(60,40,140,.35)]" />
    </button>
  );
}

/**
 * Types rotating ideas out letter by letter (static rotation with reduced motion). The first idea
 * starts fully written, so it is in the server-rendered page and paints before any script runs.
 */
function useTypingIdeas(ideas: string[] | undefined, active: boolean): string {
  const reduced = useReducedMotion();
  const [text, setText] = useState(() => ideas?.[0] ?? '');
  // Where the typing is, kept across pauses (the person typed, then cleared the box again).
  const pos = useRef<{ idea: number; i: number; phase: 'type' | 'hold' | 'erase' }>({ idea: 0, i: ideas?.[0]?.length ?? 0, phase: 'hold' });
  useEffect(() => {
    if (!ideas?.length || !active) return;
    const p = pos.current;
    let timer: ReturnType<typeof setTimeout>;
    if (reduced) {
      const iv = setInterval(() => {
        p.idea = (p.idea + 1) % ideas.length;
        setText(ideas[p.idea]);
      }, 4000);
      return () => clearInterval(iv);
    }
    const tick = () => {
      const s = ideas[p.idea % ideas.length];
      if (p.phase === 'type') {
        p.i++;
        setText(s.slice(0, p.i));
        if (p.i >= s.length) p.phase = 'hold';
        timer = setTimeout(tick, p.phase === 'hold' ? 2200 : 38 + Math.random() * 46);
      } else if (p.phase === 'hold') {
        p.phase = 'erase';
        timer = setTimeout(tick, 20);
      } else {
        p.i = Math.max(0, p.i - 2);
        setText(s.slice(0, p.i));
        if (p.i === 0) {
          p.phase = 'type';
          p.idea = (p.idea + 1) % ideas.length;
          timer = setTimeout(tick, 380);
        } else timer = setTimeout(tick, 16);
      }
    };
    timer = setTimeout(tick, p.phase === 'hold' ? 2200 : 60);
    return () => clearTimeout(timer);
  }, [ideas, active, reduced]);
  return text;
}
