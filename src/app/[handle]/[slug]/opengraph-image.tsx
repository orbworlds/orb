// Link-preview image for /<owner>/<world>: the same image as /w/<id>.
import WorldImage from '../../w/[id]/opengraph-image';
import { resolvePath } from '@/server/paths';
import { ready } from '@/server/schema';

export const alt = 'A world made with Orb';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ handle: string; slug: string }> }) {
  const { handle, slug } = await params;
  const id = await resolvePath(await ready(), handle.toLowerCase(), slug.toLowerCase()).catch(() => null);
  return WorldImage({ params: Promise.resolve({ id: id ?? '' }) });
}
