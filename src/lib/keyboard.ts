// Worlds that need a keyboard (and usually a mouse) to play carry the tag "keyboard". On phones,
// Explore shows them at the end of each page, their cards say so, and opening one says so too.

export const KEYBOARD_TAG = 'keyboard';

export const needsKeyboard = (w: { tags: string[] }): boolean => w.tags.includes(KEYBOARD_TAG);

/** A touch screen with no mouse; the same test as the `phone:` variant in globals.css. */
export const PHONE_MEDIA = '(hover: none) and (pointer: coarse)';

export function onPhone(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia(PHONE_MEDIA).matches;
}

/** Worlds that play by touch first, keeping each group's order. */
export function touchFirst<T extends { tags: string[] }>(worlds: T[]): T[] {
  return [...worlds.filter((w) => !needsKeyboard(w)), ...worlds.filter(needsKeyboard)];
}
