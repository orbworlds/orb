import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { Notice } from './Notice';

const LINK = 'inline-flex h-10 phone:h-11 items-center gap-2 rounded-full px-4 text-[14px] font-medium transition-[background,opacity] duration-200 ease-[var(--ease)]';

export const metadata: Metadata = { title: 'Nothing out here' };

export default function NotFound() {
  return (
    <Notice title="Nothing out here" text="This page drifted off into the clouds.">
      <Link href="/" className={`${LINK} bg-ink text-paper hover:opacity-90`}>
        <Icon name="sparkle" size={17} />
        New world
      </Link>
      <Link href="/explore" className={`${LINK} glass text-ink hover:bg-[var(--glass-bg-strong)]`}>
        <Icon name="compass" size={17} />
        Explore
      </Link>
    </Notice>
  );
}
