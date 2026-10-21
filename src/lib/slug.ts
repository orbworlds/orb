/** "Cloud Castle!" → "cloud-castle" (ASCII, max 48): world slugs and account handles, as the server makes them. */
export function slugify(name: string, fallback = 'world'): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return s || fallback;
}
