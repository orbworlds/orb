// Looping video previews of the top worlds, played on their cards (Explore, the start screen's row).
// Recorded by scripts/previews.mjs into public/previews/<id>.webm (VP9) and .mp4 (H.264, for browsers
// without VP9); src/data/previews.json maps each world that has one to a hash of its files, so a new
// recording is fetched fresh.
import previews from '@/data/previews.json';

const VERSIONS: Record<string, string> = previews;

export interface PreviewVideo {
  webm: string;
  mp4: string;
}

/** The world's preview video, or null when it has none. */
export function previewVideo(id: string): PreviewVideo | null {
  const v = VERSIONS[id];
  return v ? { webm: `/previews/${id}.webm?v=${v}`, mp4: `/previews/${id}.mp4?v=${v}` } : null;
}
