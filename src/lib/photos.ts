'use client';
// Photos people attach to a chat message: picked (or taken with the camera, on a phone), pasted or
// dropped. Each is read here, in the browser, into what the AI sees (a JPEG, or a PNG when it has
// see-through parts, at most 1600 px on its long side and under BUILD_LIMITS.photo) and a small
// copy the chat shows and keeps. The full copies of what this page view sent stay here, for a closer
// look and for asking again.
import { BUILD_LIMITS } from '@/lib/engine/prompt';

export interface Photo {
  id: string;
  /** What the AI sees, and what a world can use: a data URL. */
  full: string;
  /** What the chat shows (and keeps with the message): a small JPEG data URL. */
  thumb: string;
}

const FULL_SIDE = 1600;
const THUMB_SIDE = 320;

let seq = 0;

/** A picture a browser may be able to read (phones' own HEIC photos included: browsers that can't say so). */
export const isPhotoFile = (f: File): boolean => /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp)$/i.test(f.name);

/** `img` drawn at most `side` px on its long side (on white, when `opaque`). */
function draw(img: HTMLImageElement, side: number, opaque: boolean): HTMLCanvasElement {
  const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = c.getContext('2d')!;
  if (opaque) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** Whether a picture has see-through parts (a small copy tells). */
function seeThrough(img: HTMLImageElement): boolean {
  const c = draw(img, 64, false);
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
      const c = draw(img, side, !alpha);
      full = alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
      if (full.length > BUILD_LIMITS.photo && !alpha) full = c.toDataURL('image/jpeg', 0.7);
      if (full.length <= BUILD_LIMITS.photo) break;
    }
    if (full.length > BUILD_LIMITS.photo) throw new Error('too big');
    const thumb = draw(img, THUMB_SIDE, true).toDataURL('image/jpeg', 0.72);
    return { id: `p${Date.now().toString(36)}${seq++}`, full, thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** `current` with what `files` add (up to BUILD_LIMITS.photos), and what to tell the person if not all could be. */
export async function addPhotos(current: Photo[], files: File[]): Promise<{ photos: Photo[]; problem?: string }> {
  const pictures = files.filter(isPhotoFile);
  let problem = pictures.length < files.length ? 'Only pictures can be added to a message.' : undefined;
  const room = BUILD_LIMITS.photos - current.length;
  if (pictures.length > room) problem = `Up to ${BUILD_LIMITS.photos} photos at a time.`;
  const next = [...current];
  for (const f of pictures.slice(0, Math.max(0, room))) {
    try {
      next.push(await readPhoto(f));
    } catch {
      problem = /heic|heif/i.test(f.type || f.name) ? 'This browser can’t open HEIC photos. Try a JPEG or PNG.' : 'Couldn’t read that picture. Try a JPEG or PNG.';
    }
  }
  return { photos: next, problem };
}

// --- what this page view sent ----------------------------------------------------------------

const sent = new Map<string, string[]>();

/** Keep the full photos a message was sent with (for a closer look, and to ask again). */
export function keepSent(messageId: string, photos: Photo[]): void {
  if (photos.length) sent.set(messageId, photos.map((p) => p.full));
}

/** The full photos a message was sent with in this page view (after a reload: none). */
export const sentPhotos = (messageId: string): string[] | undefined => sent.get(messageId);
