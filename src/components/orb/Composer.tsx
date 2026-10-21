'use client';
// The message box. Auto-grows, Enter sends (Shift+Enter = newline, IME-safe), the send button
// turns into stop while building. Two looks: 'hero' (big, frosted, ideas typed out in the
// placeholder's color, as a hint) and 'panel' (compact).
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Icon } from '@/components/ui/Icon';
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
}

const MAX_H = { hero: 168, panel: 176 };

export function Composer({ value, onChange, onSend, onStop, building = false, placeholder, ideas, blocked, variant = 'panel', focusSignal, autoFocus, id }: ComposerProps) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const hero = variant === 'hero';
  const [focused, setFocused] = useState(false);
  const typed = useTypingIdeas(ideas, !value);

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

  const canSend = !!value.trim() && !building && !blocked;
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

  const showIdeas = !value && !!ideas?.length && !blocked;
  const ph = blocked || (showIdeas ? '' : placeholder);

  return (
    <form
      onSubmit={onSubmit}
      className={
        hero
          ? `glass-strong relative flex items-end gap-2 rounded-[28px] py-2.5 pr-2.5 pl-5 transition-shadow duration-300 sm:py-3 sm:pr-3 sm:pl-6 ${focused ? 'shadow-[inset_0_0_0_1px_var(--glass-hairline),0_0_0_1px_color-mix(in_oklab,var(--iris-1)_35%,transparent),0_0_0_6px_color-mix(in_oklab,var(--iris-1)_10%,transparent),var(--shadow-soft)]' : ''}`
          : `relative flex items-end gap-1.5 rounded-[22px] bg-[var(--field-bg)] py-1.5 pr-1.5 pl-1.5 transition-[background,box-shadow] duration-200 ${focused ? 'bg-[var(--field-bg-focus)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--iris-1)_40%,transparent),0_0_0_4px_color-mix(in_oklab,var(--iris-1)_10%,transparent)]' : ''}`
      }
    >
      <div className={`relative min-w-0 flex-1 ${hero ? 'py-[7px]' : 'py-[6px] pl-2.5'}`}>
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
