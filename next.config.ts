import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

/**
 * Former addresses hand people over to the current one (docs/operations.md "Moving to a new domain",
 * src/server/move.ts): a browser opening a page there goes through the hand-off (bringing its
 * account, worlds, chats and settings) and lands on the same path here; browsers that already
 * moved, and everything else (crawlers, link previews), get a permanent redirect. The API, Next's
 * files, /.well-known/*, files and the hand-off page itself stay where they are.
 *
 * Built from the environment at build time, so none of this exists until ORB_FORMER_ORIGINS is set
 * (and only requests for those hosts ever match).
 */
/**
 * Curated worlds that Orb replaced with one of its own: their old addresses lead to the new world.
 * (Dropping a seed deletes its row, and with it the paths it had.)
 */
function replacedWorlds() {
  const replaced = [
    // Former Explore path of Wildbrush, now the native world
    { id: "wildbrush", path: "/web/wildbrush", to: "/orb/wildbrush" },
  ];
  return replaced.flatMap(({ id, path, to }) => [
    { source: path, destination: to, permanent: true },
    { source: `/w/${id}`, destination: to, permanent: true },
  ]);
}

function moveRedirects() {
  const origin = (url: string) => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };
  const site = origin(process.env.NEXT_PUBLIC_SITE_URL || "") ?? "https://orbworld.vercel.app";
  // Rules match by hostname: one naming the site's own would redirect the site to itself.
  const former = (process.env.ORB_FORMER_ORIGINS || "")
    .split(/[\s,]+/)
    .map((o) => (o ? origin(o) : null))
    .filter((o): o is string => !!o && new URL(o).hostname !== new URL(site).hostname);
  const pages = "/:path((?!(?:api|_next|_vercel|dev|\\.well-known)(?:/|$)|move$|__nextjs)(?!.*\\.[^/]*$).+)";
  return former.flatMap((o) => {
    const { hostname, host } = new URL(o);
    const onHost = { type: "host" as const, value: hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") };
    const visit = [onHost, { type: "header" as const, key: "sec-fetch-dest", value: "document" }];
    const notMoved = [{ type: "cookie" as const, key: "orb_moved" }];
    const start = `${site}/api/move/start/${encodeURIComponent(host)}`;
    return [
      { source: "/", has: visit, missing: notMoved, destination: start, permanent: false },
      { source: pages, has: visit, missing: notMoved, destination: `${start}/:path`, permanent: false },
      { source: "/", has: [onHost], destination: `${site}/`, permanent: true },
      { source: pages, has: [onHost], destination: `${site}/:path`, permanent: true },
    ];
  });
}

const nextConfig: NextConfig = {
  // Share images read thumbnails from /public by a computed path, so the tracer copies all of /public
  // (preview videos included) into every function; they are served as static files anyway. Vercel's
  // runtime is glibc Linux: sharp's musl and wasm builds are dead weight there.
  outputFileTracingExcludes: {
    "/**": [
      "public/previews/**",
      "node_modules/@img/sharp-libvips-linuxmusl-x64/**",
      "node_modules/@img/sharp-linuxmusl-x64/**",
      "node_modules/@img/sharp-wasm32/**",
    ],
  },
  env: {
    // Vercel BotID (src/server/botid.ts) needs Vercel's request context: on in builds made there.
    ORB_BOTID: process.env.VERCEL ? "on" : "",
  },
  async headers() {
    return [
      {
        // World files (/api/tree/…) set their own sandboxing headers.
        source: "/:path((?!api/tree/).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Orb's pages are never shown inside other sites (no clickjacking of Delete, Share…).
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
  async redirects() {
    return [...moveRedirects(), ...replacedWorlds()];
  },
};

export default withBotId(nextConfig);
