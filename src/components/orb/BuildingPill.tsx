'use client';
// A slim glass pill at the top of the world while a build runs: tiny spinner, the current step in
// shimmer ("Planting cherry trees…") and a step counter. Shown while the panel is collapsed (the
// open panel narrates the build); when the build lands it shows a ✓ and fades away.
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import type { BuildProgress } from '@/lib/engine/useBuild';
import type { ChatMessage } from '@/lib/types';

// Common imperative verbs in step labels → present participle ("Plant" → "Planting").
const DOUBLE = new Set(['put', 'set', 'get', 'cut', 'dig', 'drop', 'plan', 'pin', 'run', 'shut', 'skip', 'slip', 'spin', 'stop', 'swap', 'tap', 'trim', 'wrap', 'grab', 'hug', 'sit', 'hit', 'chop', 'drag', 'dim', 'map', 'snap', 'tip', 'top', 'zip', 'flip', 'clip', 'nap', 'pop']);
const KEEP_E = new Set(['see', 'free', 'agree', 'flee', 'dye', 'eye', 'hoe', 'toe', 'be']);
const VERB = new Set([
  'add', 'adjust', 'animate', 'arrange', 'attach', 'balance', 'boost', 'bring', 'build', 'carve', 'center', 'change', 'clean', 'color', 'colour', 'connect', 'create', 'decorate',
  'design', 'draw', 'drift', 'fill', 'fix', 'float', 'frame', 'give', 'glow', 'grow', 'hang', 'hide', 'improve', 'introduce', 'keep', 'lay', 'let', 'light', 'line', 'load', 'make',
  'move', 'paint', 'place', 'plant', 'polish', 'raise', 'refine', 'remove', 'render', 'replace', 'reshape', 'restore', 'rotate', 'scatter', 'sculpt', 'shape', 'show', 'smooth',
  'soften', 'spawn', 'spread', 'sprinkle', 'start', 'style', 'switch', 'teach', 'tidy', 'tune', 'turn', 'tweak', 'update', 'warm', 'write', 'brighten', 'darken', 'enlarge', 'shrink',
  'speed', 'slow', 'stack', 'wire', 'hook', 'track', 'count', 'score', 'play', 'sound', 'mix', 'compose', 'invent', 'welcome', 'open', 'close', 'fade', 'bake', 'pave',
  ...DOUBLE,
]);

export function gerund(label: string): string {
  const clean = label.trim().replace(/[.…]+$/, '');
  const m = /^([A-Za-z]+)(\b.*)$/.exec(clean);
  if (!m) return `${clean}…`;
  const [, word, rest] = m;
  const w = word.toLowerCase();
  if (!VERB.has(w)) return `${clean}…`;
  let ing: string;
  if (DOUBLE.has(w)) ing = w + w[w.length - 1] + 'ing';
  else if (w.endsWith('ie')) ing = w.slice(0, -2) + 'ying';
  else if (w.endsWith('e') && !KEEP_E.has(w)) ing = w.slice(0, -1) + 'ing';
  else ing = w + 'ing';
  const cased = word[0] === word[0].toUpperCase() ? ing[0].toUpperCase() + ing.slice(1) : ing;
  return `${cased}${rest}…`;
}

type Phase = 'hidden' | 'building' | 'done';

export function BuildingPill({ isBuilding, progress, messages, top }: { isBuilding: boolean; progress: BuildProgress | null; messages: ChatMessage[]; top: string }) {
  const [phase, setPhase] = useState<Phase>('hidden');
  const wasBuilding = useRef(false);
  const last = messages.findLast((m) => m.role === 'assistant');
  const b = last?.build;

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    if (isBuilding) setPhase('building');
    else if (wasBuilding.current) {
      // Celebrate only real changes; errors and stops just fade away.
      if (b?.status === 'done' && b.steps.some((s) => s.status === 'done')) {
        setPhase('done');
        t = setTimeout(() => setPhase('hidden'), 1600);
      } else setPhase('hidden');
    }
    wasBuilding.current = isBuilding;
    return () => clearTimeout(t);
  }, [isBuilding, b?.status, b?.steps]);

  const steps = b?.steps ?? [];
  const pending = steps.find((s) => s.status === 'pending');
  const current = progress?.label ?? pending?.label;
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const stepNo = current ? doneCount + 1 : doneCount;
  const label = phase === 'done' ? 'Done' : current ? gerund(current) : b?.repair ? 'Fixing a little thing…' : steps.length ? 'Finishing up…' : b ? 'Building…' : 'Thinking…';

  const visible = phase !== 'hidden';
  return (
    <div
      className="pointer-events-none fixed left-1/2 z-[25] flex -translate-x-1/2 justify-center"
      style={{ top }}
    >
      <div
        className="glass flex h-9 max-w-[min(440px,calc(100vw-32px))] items-center gap-2.5 rounded-full pr-4 pl-3 text-[13.5px] transition-[opacity,transform,filter] duration-[450ms] ease-[var(--ease)]"
        style={{ opacity: visible ? 1 : 0, transform: visible ? 'none' : 'translateY(-10px) scale(.96)', filter: visible ? 'none' : 'blur(4px)' }}
        role="status"
      >
        {phase === 'done' ? (
          <span className="tick-animate flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--ok)] text-white">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2.5 6.3l2.3 2.3L9.6 3.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        ) : (
          <Spinner size={14} />
        )}
        <span key={label} className={`animate-fade-in min-w-0 truncate font-medium ${phase === 'done' ? 'text-ink' : 'shimmer-text'}`}>
          {label}
        </span>
        {phase === 'building' && stepNo > 0 && (
          <span className="shrink-0 border-l border-ink-4 pl-2.5 text-[12px] text-ink-3 tabular-nums">Step {stepNo}</span>
        )}
      </div>
    </div>
  );
}
