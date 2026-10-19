'use client';
// Recording a clip (a small pill with the seconds left), then the clip: a preview, Share… (the
// phone's share sheet, with the video file) and Download. See src/state/clips.ts.
import { useEffect, useMemo, useState } from 'react';
import { track } from '@/lib/analytics';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useClip, CLIP_MS } from '@/state/clips';
import { shareUrl } from '@/state/share';
import { toast } from '@/state/toast';
import { useWorld } from '@/state/world';
import { slugify } from './ShareSheet';

export function ClipSheet() {
  const { status, startedAt, blob, url, world, record, close } = useClip();
  const file = useMemo(() => (blob && world ? new File([blob], `${slugify(world.name)}-on-orb.${blob.type === 'video/mp4' ? 'mp4' : 'webm'}`, { type: blob.type }) : null), [blob, world]);
  const canShare = !!file && typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });

  const share = async () => {
    if (!file || !world) return;
    try {
      await navigator.share({ files: [file], title: world.name, text: `${world.name} on Orb · ${shareUrl(world)}` });
      track('clip_share', { world_id: world.id, how: 'native' });
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') toast('Couldn’t share the clip — download it instead.', 'error');
    }
  };
  const download = () => {
    if (!url || !file || !world) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    track('clip_share', { world_id: world.id, how: 'download' });
  };

  return (
    <>
      {status === 'recording' && <Recording startedAt={startedAt} />}
      <Modal open={status === 'ready'} onClose={close} title="Your clip" width={520}>
        {url && (
          <div className="flex flex-col gap-4">
            <video src={url} autoPlay loop muted playsInline controls className="max-h-[56vh] w-full rounded-[16px] bg-black object-contain" />
            <p className="px-1 text-[13px] leading-snug text-ink-2">Post it on TikTok, Instagram or X. It shows where to find your world.</p>
            <div className="flex flex-wrap gap-2">
              {canShare && (
                <Button variant="primary" icon="share" onClick={() => void share()}>
                  Share…
                </Button>
              )}
              <Button variant={canShare ? 'glass' : 'primary'} icon="download" onClick={download}>
                Download
              </Button>
              {world && (
                <Button
                  variant="ghost"
                  icon="video"
                  onClick={() => {
                    // Again in the same world, if it's still the one on screen.
                    const w = useWorld.getState().world;
                    close();
                    if (w && w.id === world.id) void record(w);
                  }}
                >
                  Record again
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function Recording({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((CLIP_MS - (now - startedAt)) / 1000));
  return (
    <div
      role="status"
      className="glass fixed z-50 flex h-10 items-center gap-2 rounded-full px-4 text-[13.5px] font-medium text-ink"
      style={{ top: 'calc(var(--safe-t) + 14px)', left: '50%', transform: 'translateX(-50%)' }}
    >
      <span aria-hidden="true" className="h-2.5 w-2.5 animate-pulse rounded-full bg-[#ff4d6d]" />
      {left > 0 ? `Recording a clip · ${left}` : 'Making your clip…'}
    </div>
  );
}
