import Shell from '@/components/Shell';

// The start canvas: a calm blank world, worlds to step into and a composer to make one. A static
// page (served from the CDN): ?prompt= (prefills the composer) and ?template= (starts from a
// template) are read in the browser.
export default function Home() {
  return <Shell mode="start" />;
}
