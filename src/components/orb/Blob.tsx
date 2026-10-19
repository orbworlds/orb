'use client';
// The blob, the character Orb gives people in worlds, drawn as in the world SDK's visitors (front
// view, its height = 100 units, ground at y = 100) with what it wears (src/lib/looks.ts).

import { useId } from 'react';

/** `color` moved toward `to` by `t` (0–1). */
function mix(color: string, to: string, t: number): string {
  const c = /^#([0-9a-f]{6})$/i.exec(color)?.[1] ?? '8b7bff';
  const d = /^#([0-9a-f]{6})$/i.exec(to)?.[1] ?? '000000';
  const ch = (s: string, i: number) => parseInt(s.slice(i, i + 2), 16);
  return `#${[0, 2, 4].map((i) => Math.round(ch(c, i) + (ch(d, i) - ch(c, i)) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** `head`: only the head and what's on it, bigger (for small tiles). */
export function Blob({ color, wear, size = 88, label, head = false }: { color: string; wear: readonly string[]; size?: number; label?: string; head?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const on = (x: string) => wear.includes(x);
  const url = (k: string) => `url(#${id}${k})`;
  const [vb, aspect] = head ? ['14 -24 72 80', 80 / 72] : ['0 -26 100 134', 1.34];
  return (
    <svg viewBox={vb} width={size} height={Math.round(size * aspect)} role="img" aria-label={label ?? 'Blob'} className="block overflow-hidden">
      <defs>
        <radialGradient id={`${id}b`} cx="36%" cy="28%" r="78%">
          <stop offset="0" stopColor={mix(color, '#ffffff', 0.42)} />
          <stop offset="0.55" stopColor={color} />
          <stop offset="1" stopColor={mix(color, '#000000', 0.16)} />
        </radialGradient>
        <radialGradient id={`${id}s`}>
          <stop offset="0" stopColor="#000" stopOpacity="0.22" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe08a" />
          <stop offset="1" stopColor="#e9a920" />
        </linearGradient>
        <radialGradient id={`${id}h`}>
          <stop offset="0" stopColor="#ffe9a0" stopOpacity="0.75" />
          <stop offset="1" stopColor="#ffe9a0" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="50" cy="100" rx="38" ry="7" fill={url('s')} />
      {on('bunny-ears') && (
        <g>
          {[-1, 1].map((s) => (
            <g key={s} transform={`rotate(${s * 11.5} ${50 + s * 8} 4)`}>
              <ellipse cx={50 + s * 8} cy="2" rx="4.9" ry="16" fill="#fbf8ff" stroke="#e6e0ef" strokeWidth="0.6" />
              <ellipse cx={50 + s * 8} cy="3" rx="2.5" ry="11.5" fill="#ffb6cf" />
            </g>
          ))}
        </g>
      )}
      <ellipse cx="50" cy="54" rx="31" ry="40" fill={url('b')} />
      {[-1, 1].map((s) => (
        <ellipse key={s} cx={50 + s * 15} cy="94.5" rx="10" ry="5.5" fill={mix(color, '#000000', 0.28)} />
      ))}
      {[-1, 1].map((s) => (
        <g key={s}>
          <ellipse cx={50 + s * 12} cy="42" rx="3.9" ry="5.1" fill="#1d1b2a" />
          <circle cx={50 + s * 12 - 1.1} cy="40.2" r="1.15" fill="#fff" opacity="0.85" />
        </g>
      ))}
      {on('blush') && [-1, 1].map((s) => <ellipse key={s} cx={50 + s * 18.5} cy="50" rx="4.8" ry="2.8" fill="#ff4f86" opacity="0.6" />)}
      {on('round-glasses') && (
        <g fill="none" stroke="#6b4a2b" strokeWidth="1.8">
          <circle cx="38" cy="41.5" r="7.4" fill="#ffffff" fillOpacity="0.14" />
          <circle cx="62" cy="41.5" r="7.4" fill="#ffffff" fillOpacity="0.14" />
          <path d="M45.4 40.4 Q50 38.8 54.6 40.4" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      )}
      {on('shades') && (
        <g>
          <path d="M45.6 40 Q50 38.6 54.4 40" fill="none" stroke="#15131d" strokeWidth="1.8" strokeLinecap="round" />
          {[-1, 1].map((s) => (
            <g key={s}>
              <ellipse cx={50 + s * 11.8} cy="41.6" rx="7.8" ry="5.3" fill="#15131d" />
              <ellipse cx={50 + s * 11.8 - 3} cy="39.4" rx="2.1" ry="1" fill="#fff" opacity="0.75" transform={`rotate(-17 ${50 + s * 11.8 - 3} 39.4)`} />
            </g>
          ))}
        </g>
      )}
      {on('sprout') && (
        <g>
          <path d="M50 16 Q49.4 9 50 3.5" fill="none" stroke="#3f9b4f" strokeWidth="2.2" strokeLinecap="round" />
          <ellipse cx="44.6" cy="3.6" rx="5.6" ry="2.3" fill="#5fcf6b" transform="rotate(28 44.6 3.6)" />
          <ellipse cx="55.4" cy="3.6" rx="5.6" ry="2.3" fill="#5fcf6b" transform="rotate(-28 55.4 3.6)" />
        </g>
      )}
      {on('flower') && (
        <g transform="translate(63 17.5)">
          {[0, 60, 120, 180, 240, 300].map((a) => (
            <ellipse key={a} cx="6.2" cy="0" rx="4.8" ry="2.9" fill="#fffaf5" stroke="#e8e1d8" strokeWidth="0.5" transform={`rotate(${a})`} />
          ))}
          <circle r="3.4" fill="#ffd84d" />
        </g>
      )}
      {on('party-hat') && (
        <g transform="rotate(12.6 52.5 17.5)">
          <path d="M40.5 17.5 L52.5 -14.5 L64.5 17.5 Q52.5 21 40.5 17.5 Z" fill="#ff78ad" />
          <path d="M43.5 9.6 Q52.5 12.2 61.5 9.6" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M47.3 -0.4 Q52.5 1.2 57.7 -0.4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
          <circle cx="52.5" cy="-15.5" r="3.8" fill="#ffd84d" />
        </g>
      )}
      {on('top-hat') && (
        <g transform="rotate(-6 50 16)">
          <rect x="39" y="-8" width="22" height="24" rx="1.5" fill="#2a2633" />
          <ellipse cx="50" cy="-8" rx="11" ry="2.2" fill="#3a3545" />
          <rect x="38.7" y="9.5" width="22.6" height="4.6" fill="#e0485f" />
          <ellipse cx="50" cy="16.2" rx="18" ry="2.6" fill="#2a2633" />
        </g>
      )}
      {on('halo') && (
        <g>
          <circle cx="50" cy="1" r="19" fill={url('h')} />
          <ellipse cx="50" cy="1" rx="14" ry="3.8" fill="none" stroke="#ffd84d" strokeWidth="2.8" />
        </g>
      )}
      {on('crown') && (
        <g>
          {[41.2, 58.8].map((x) => (
            <path key={x} d={`M${x - 2.2} 12.5 L${x} 5.2 L${x + 2.2} 12.5 Z`} fill="#d9981a" />
          ))}
          {[35.7, 50, 64.3].map((x) => (
            <g key={x}>
              <path d={`M${x - 2.6} 12.5 L${x} 4.6 L${x + 2.6} 12.5 Z`} fill={url('g')} />
              <circle cx={x} cy="4.2" r="1.6" fill="#ffd34a" />
            </g>
          ))}
          <path d="M35 12 Q50 14.6 65 12 L65 20 Q50 22.6 35 20 Z" fill={url('g')} />
          <circle cx="50" cy="16.6" r="2.4" fill="#ff3d6e" />
          <circle cx="40.5" cy="16.2" r="1.6" fill="#45b8ff" />
          <circle cx="59.5" cy="16.2" r="1.6" fill="#45b8ff" />
        </g>
      )}
    </svg>
  );
}
