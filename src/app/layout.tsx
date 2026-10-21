import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono, Instrument_Serif } from 'next/font/google';
import { PageViews } from '@/components/PageViews';
import { SITE } from '@/lib/site';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
// Only some panels and the lab use it: fetched when first shown, not on every page.
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'], preload: false });
const instrumentSerif = Instrument_Serif({ variable: '--font-instrument-serif', subsets: ['latin'], weight: '400', style: ['normal', 'italic'] });

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: 'Orb — make and play worlds', template: '%s · Orb' },
  description: 'Say what you imagine and watch it come alive. Build games, worlds and toys by chatting — share them with a link. No install, no sign-up.',
  openGraph: { siteName: 'Orb', type: 'website' },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Android: the keyboard shrinks the page, so what's at its bottom (the chat) stays in view.
  interactiveWidget: 'resizes-content',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f5fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0d14' },
  ],
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable}`}>
      <body>
        {children}
        <PageViews />
      </body>
    </html>
  );
}
