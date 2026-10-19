// Minimal stroke icon set (24px grid, lucide-style). <Icon name="send" size={18} />
import type { SVGProps } from 'react';

const P: Record<string, string> = {
  sparkle: 'M12 3l1.6 4.8L18 9.5l-4.4 1.7L12 16l-1.6-4.8L6 9.5l4.4-1.7z M19 15l.7 2 2 .8-2 .7-.7 2-.7-2-2-.7 2-.8z',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M15.5 8.5l-2 5-5 2 2-5z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  x: 'M6 6l12 12 M18 6L6 18',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'arrow-up': 'M12 19V5 M5 12l7-7 7 7',
  'arrow-left': 'M19 12H5 M12 19l-7-7 7-7',
  stop: 'M7 7h10v10H7z',
  undo: 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  share: 'M12 3v12 M7 8l5-5 5 5 M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5',
  code: 'M8 7l-5 5 5 5 M16 7l5 5-5 5',
  remix: 'M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9',
  lock: 'M6 11h12v10H6z M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  play: 'M8 5l11 7-11 7z',
  video: 'M3 7h12v10H3z M15 11l6-4v10l-6-4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  github: 'M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  key: 'M14 10a4 4 0 1 0-1.2 2.8L21 21 M17 17l2-2 M15 15l1.5-1.5',
  plus: 'M12 5v14 M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  image: 'M4 5h16v14H4z M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18 M15.5 9.5h.01',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l3 2',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  keyboard: 'M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
  minimize: 'M5 12h14',
  maximize: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  download: 'M12 4v12 M7 11l5 5 5-5 M5 20h14',
  pencil: 'M4 20h4L19 9l-4-4L4 16z M14 6l4 4',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  wand: 'M15 4V2 M15 10V8 M11 6h2 M17 6h2 M3 21l12-12 M13.5 4.5l1 1',
  chat: 'M5 18l-2 3V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z',
  refresh: 'M20 11a8 8 0 0 0-14.8-4 M4 4v4h4 M4 13a8 8 0 0 0 14.8 4 M20 20v-4h-4',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3 M10 16l-4-4 4-4 M6 12h10',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21a7 7 0 0 1 14 0 M16 3.6a4 4 0 0 1 0 7.8 M22 21a7 7 0 0 0-4.6-6.6',
  'user-plus': 'M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M3 21a7 7 0 0 1 14 0 M19 8v6 M16 11h6',
  send: 'M21 3L10 14 M21 3l-6.5 18-4.5-7-7-4.5z',
  coins: 'M9 11a6 3 0 1 0 0-6 6 3 0 0 0 0 6z M3 8v4c0 1.7 2.7 3 6 3s6-1.3 6-3V8 M9 15v4 M15 12.2c3.3 0 6 1.3 6 3s-2.7 3-6 3-6-1.3-6-3 M21 15.2v3.6c0 1.7-2.7 3-6 3s-6-1.3-6-3v-.8',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18, strokeWidth = 1.75, ...rest }: { name: IconName | string; size?: number; strokeWidth?: number } & SVGProps<SVGSVGElement>) {
  const d = P[name] ?? P.sparkle;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {d.split(' M').map((seg, i) => (
        <path key={i} d={i === 0 ? seg : `M${seg}`} />
      ))}
    </svg>
  );
}
