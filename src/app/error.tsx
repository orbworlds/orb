'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { reportError } from '@/lib/report';
import { Notice } from './Notice';

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error('[orb] page error', error);
    reportError(error, { where: error.digest ? `digest ${error.digest}` : '' });
  }, [error]);

  return (
    <Notice title="Something went wobbly" text="Orb tripped over this page. Your worlds are safe.">
      <Button variant="primary" className="phone:h-11" onClick={() => retry()}>
        Try again
      </Button>
      {/* A full load: client navigation keeps the state that broke, and on / the boundary stays up. */}
      <Button variant="glass" className="phone:h-11" onClick={() => window.location.assign(window.location.origin)}>
        Home
      </Button>
    </Notice>
  );
}
