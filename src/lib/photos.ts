'use client';
// Photos and videos people attach to a chat message: picked (or taken with the camera, on a phone),
// pasted or dropped. Each is read here, in the browser, into what the AI sees (a photo: a JPEG, or a
// PNG when it has see-through parts, at most 1600 px on its long side and under BUILD_LIMITS.photo;
// a video: BUILD_LIMITS.frames frames spread over it, as the AI can't watch one) and a small copy
// the chat shows and keeps. A video small enough (VIDEO_FILE_MAX) also goes on Orb now, so a build
// can put it in the world. The full copies of what this page view sent stay here, for a closer look
// and for asking again.
import { api } from '@/lib/api';
import { BUILD_LIMITS } from '@/lib/engine/prompt';
import type { BuildVideo } from '@/lib/types';

export interface Photo {
  id: string;
  /** What the AI sees, and what a world can use: a data URL (a video's: its first frame). */
  full: string;
  /** What the chat shows (and keeps with the message): a small JPEG data URL. */
  thumb: string;
  /** A video: its frames, its length, and its file on Orb (when it was small enough). */
  video?: BuildVideo;
}

const FULL_SIDE = 1600;
const THUMB_SIDE = 320;
const FRAME_SIDE = 1024;
/** The biggest video that also goes on Orb, for a world to use (src/server/uploads.ts). */
const VIDEO_FILE_MAX = 4_000_000;

let seq = 0;

/** A picture a browser may be able to read (phones' own HEIC photos included: browsers that can't say so). */
export const isPhotoFile = (f: File): boolean => /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp)$/i.test(f.name);
/** A video. */
export const isVideoFile = (f: File): boolean => /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm)$/i.test(f.name);
/** What a message can take: photos and videos. */
export const isAttachable = (f: File): boolean => isPhotoFile(f) || isVideoFile(f);

/** `src` (`w` × `h`) drawn at most `side` px on its long side (on white, when `opaque`). */
function draw(src: CanvasImageSource, w: number, h: number, side: number, opaque: boolean): HTMLCanvasElement {
  const scale = Math.min(1, side / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d')!;
  if (opaque) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Whether a picture has see-through parts (a small copy tells). */
function seeThrough(img: HTMLImageElement): boolean {
  const c = draw(img, img.naturalWidth, img.naturalHeight, 64, false);
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

/** One photo, ready to send. Throws when the browser can't read it. */
export async function readPhoto(file: File): Promise<Photo> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty picture');
    const alpha = /png|webp|gif|avif/.test(file.type) && seeThrough(img);
    let full = '';
    // Smaller until it fits: a JPEG first at good quality, then a little less.
    for (let side = FULL_SIDE; side >= 256; side = Math.round(side * 0.75)) {
      const c = draw(img, img.naturalWidth, img.naturalHeight, side, !alpha);
      full = alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
      if (full.length > BUILD_LIMITS.photo && !alpha) full = c.toDataURL('image/jpeg', 0.7);
      if (full.length <= BUILD_LIMITS.photo) break;
    }
    if (full.length > BUILD_LIMITS.photo) throw new Error('too big');
    const thumb = draw(img, img.naturalWidth, img.naturalHeight, THUMB_SIDE, true).toDataURL('image/jpeg', 0.72);
    return { id: `p${Date.now().toString(36)}${seq++}`, full, thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Until `event` on the video (or its error, or the time running out). */
function until(v: HTMLVideoElement, event: string, ms = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => () => {
      clearTimeout(timer);
      v.removeEventListener(event, ok);
      v.removeEventListener('error', bad);
      fn();
    };
    const ok = done(resolve);
    const bad = done(() => reject(new Error('video error')));
    const timer = setTimeout(done(() => reject(new Error('video timeout'))), ms);
    v.addEventListener(event, ok);
    v.addEventListener('error', bad);
  });
}

/** One video, ready to send: frames spread over it, and its file on Orb when it's small. Throws when the browser can't play it. */
export async function readVideo(file: File): Promise<Photo> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try {
    v.src = url;
    await until(v, 'loadeddata');
    const { videoWidth: w, videoHeight: h } = v;
    if (!w || !h) throw new Error('no picture');
    if (!Number.isFinite(v.duration)) {
      // A recording (a browser's WebM) may not say how long it is: going to its end tells.
      v.currentTime = 1e9;
      await until(v, 'seeked').catch(() => {});
    }
    const seconds = Number.isFinite(v.duration) ? Math.max(0, v.duration) : 0;
    const at = seconds > 1 ? Array.from({ length: BUILD_LIMITS.frames }, (_, i) => ((i + 0.5) / BUILD_LIMITS.frames) * seconds) : [0];
    const frames: string[] = [];
    let thumb = '';
    for (const t of at) {
      if (Math.abs(v.currentTime - t) > 0.01) {
        v.currentTime = t;
        await until(v, 'seeked');
      }
      const c = draw(v, w, h, FRAME_SIDE, true);
      let frame = c.toDataURL('image/jpeg', 0.8);
      if (frame.length > BUILD_LIMITS.frame) frame = c.toDataURL('image/jpeg', 0.55);
      if (frame.length <= BUILD_LIMITS.frame) frames.push(frame);
      if (!thumb) thumb = draw(v, w, h, THUMB_SIDE, true).toDataURL('image/jpeg', 0.72);
    }
    if (!frames.length) throw new Error('no frames');
    const kept = file.size <= VIDEO_FILE_MAX ? await api.uploadVideo(file).catch(() => null) : null;
    return { id: `v${Date.now().toString(36)}${seq++}`, full: frames[0], thumb, video: { frames, seconds: Math.round(seconds * 10) / 10, ...(kept ? { file: kept } : {}) } };
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

/** `current` with what `files` add (up to BUILD_LIMITS.photos, one of them a video), and what to tell the person if not all could be. */
export async function addPhotos(current: Photo[], files: File[]): Promise<{ photos: Photo[]; problem?: string }> {
  const usable = files.filter(isAttachable);
  let problem = usable.length < files.length ? 'Only photos and videos can be added to a message.' : undefined;
  const room = BUILD_LIMITS.photos - current.length;
  if (usable.length > room) problem = `Up to ${BUILD_LIMITS.photos} photos or videos at a time.`;
  const next = [...current];
  for (const f of usable.slice(0, Math.max(0, room))) {
    try {
      if (!isVideoFile(f)) next.push(await readPhoto(f));
      else if (next.some((p) => p.video)) problem = 'One video at a time.';
      else next.push(await readVideo(f));
    } catch {
      problem = isVideoFile(f)
        ? 'Couldn’t play that video here. Try an MP4.'
        : /heic|heif/i.test(f.type || f.name)
          ? 'This browser can’t open HEIC photos. Try a JPEG or PNG.'
          : 'Couldn’t read that picture. Try a JPEG or PNG.';
    }
  }
  return { photos: next, problem };
}

// --- what this page view sent ----------------------------------------------------------------

const sent = new Map<string, Photo[]>();

/** Keep what a message was sent with (for a closer look, and to ask again). */
export function keepSent(messageId: string, photos: Photo[]): void {
  if (photos.length) sent.set(messageId, photos);
}

/** What a message was sent with in this page view (after a reload: nothing). */
export const sentPhotos = (messageId: string): Photo[] | undefined => sent.get(messageId);
