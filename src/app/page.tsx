import Shell from '@/components/Shell';

// The start canvas: a calm blank world, worlds to step into and a composer to make one. ?prompt=
// prefills the composer, ?template= starts from a template.
export default async function Home({ searchParams }: PageProps<'/'>) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return <Shell mode="start" initialPrompt={one(sp.prompt)?.slice(0, 2000)} initialTemplate={one(sp.template)} />;
}
