// Where `orb push` sends someone the first time: allow that computer to push worlds as them
// (src/server/kit.ts). Opened in the browser they use Orb in, so their worlds are theirs here too.
import type { Metadata } from 'next';
import Allow from './Allow';

export const metadata: Metadata = {
  title: 'Push from your computer',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function KitPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <Allow code={decodeURIComponent(code).slice(0, 20)} />;
}
