#!/usr/bin/env node
// End-to-end smoke test of the full app with the mock AI (no network AI calls).
//   node scripts/e2e.mjs            # starts `next dev` on :3200 with ORB_MOCK_AI=1 and a fresh PGlite dir
//   ORB_TEST_BASE=http://localhost:3200 node scripts/e2e.mjs   # reuse a running server
// Screenshots land in .data/e2e/.

import fs from 'node:fs';
import path from 'node:path';
import { launch, routeCdn } from '../kit/lib/browser.mjs';
import { check, finish, root, startNext, stopNext } from './harness.mjs';

const WORLD_URL = /^\/(w\/[A-Za-z0-9_-]+|[a-z0-9-]+\/[a-z0-9-]+)\/?$/;
const BASE = (process.env.ORB_TEST_BASE || 'http://localhost:3200').replace(/\/$/, '');
const OUT = path.join(root, '.data/e2e');
fs.mkdirSync(OUT, { recursive: true });

async function up() {
  try {
    if ((await fetch(BASE + '/api/config', { signal: AbortSignal.timeout(3000) })).ok) return null;
  } catch {}
  const dir = '/tmp/orb-pglite-e2e';
  fs.rmSync(dir, { recursive: true, force: true });
  return startNext({ port: new URL(BASE).port, env: { ORB_MOCK_AI: '1', ORB_PGLITE_DIR: dir }, echo: !!process.env.E2E_VERBOSE });
}

const server = await up();
// Warm up route compilation (first compile in dev can take a while on a busy machine).
for (const p of ['/', '/explore', '/api/worlds?sort=featured']) await fetch(BASE + p).catch(() => {});
const browser = await launch();
try {
  for (const [label, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    console.log(`\n${label}`);
    const ctx = await browser.newContext({ viewport, hasTouch: label === 'mobile', isMobile: label === 'mobile' });
    await routeCdn(ctx);
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/.test(m.text()) && errors.push('console: ' + m.text()));

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    const hero = page.getByRole('heading', { name: 'Step into a world' });
    await hero.waitFor({ timeout: 60000 });
    check('start: hero visible', await hero.isVisible());
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${OUT}/${label}-1-start.png` });

    // Type a prompt into the hero composer (at the top of the home page's Explore) and send.
    const box = page.locator('#orb-hero-composer');
    await box.click();
    // "mocklook": the mock agent plays the world with its look tool, which this page answers.
    await box.fill('a castle on a cloud with friendly dragons mocklook');
    // A photo goes with it, picked with the box's picture button.
    const photoFile = path.join(OUT, `${label}-photo.png`);
    fs.writeFileSync(photoFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    await page.locator('form:has(#orb-hero-composer) input[type=file]').setInputFiles(photoFile);
    check('a photo picked for the message shows in the box', await page.locator('form:has(#orb-hero-composer) [aria-label="Photos to send"] img').first().waitFor({ timeout: 15000 }).then(() => true, () => false));
    await page.screenshot({ path: `${OUT}/${label}-2-typing.png` });
    await box.press('Enter');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${label}-3-building.png` });

    // Wait for the world to be saved (URL becomes /w/<id>).
    let url = '';
    for (let i = 0; i < 60; i++) {
      url = page.url();
      if (WORLD_URL.test(new URL(url).pathname)) break;
      await page.waitForTimeout(1000);
    }
    check('build saves the world → /<owner>/<world>', /^\/[a-z0-9-]+\/[a-z0-9-]+$/.test(new URL(url).pathname) && !new URL(url).pathname.startsWith('/w/'), url);
    // The agent looked at the world in this page's frame and read what it showed.
    let played = null;
    for (let i = 0; i < 60 && !played; i++) {
      played = await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
          const m = /I (played it|couldn.t look)[^"\\]*/.exec(localStorage.getItem(k) || '');
          if (m) return m[0];
        }
        return null;
      });
      if (!played) await page.waitForTimeout(1000);
    }
    check('the builder played the world in this page and saw it', /^I played it: \d+ fps, no errors, title Mock Garden, screenshot seen\.$/.test(played ?? ''), played);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${OUT}/${label}-4-built.png` });

    const pathname = new URL(url).pathname;
    const id = pathname.startsWith('/w/')
      ? pathname.slice(3)
      : await page.evaluate(async (p) => { const [h, sl] = p.slice(1).split('/'); return (await fetch(`/api/paths?handle=${h}&slug=${sl}`).then((r) => r.json())).id; }, pathname);
    if (id) {
      const res = await page.evaluate(async (wid) => {
        const r = await fetch(`/api/worlds/${wid}`, { headers: { 'x-orb-device': localStorage.getItem('orb:device') || '' } });
        return { status: r.status, body: await r.json() };
      }, id);
      check('saved world is mine, has code, version ≥ 1', res.status === 200 && res.body.world.canEdit && (res.body.world.code || '').length > 100 && res.body.world.version >= 1, res.body?.world && { canEdit: res.body.world.canEdit, version: res.body.world.version, name: res.body.world.name });
      check('world got a title', res.body?.world?.name && res.body.world.name !== 'Untitled world', res.body?.world?.name);

      // Thumbnail should be captured a few seconds after the world settles.
      let thumb = false;
      for (let i = 0; i < 20 && !thumb; i++) {
        await page.waitForTimeout(1000);
        thumb = await page.evaluate(async (wid) => (await fetch(`/api/worlds/${wid}`, { headers: { 'x-orb-device': localStorage.getItem('orb:device') || '' } }).then((r) => r.json())).world.thumbVersion > 0, id);
      }
      check('thumbnail captured + uploaded', thumb);

      // Reload: the world and the chat persist.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(6000);
      // On phones the Orb starts collapsed for everyone; open it to see the chat.
      if (label === 'mobile') {
        await page.getByRole('button', { name: /open orb/i }).first().click().catch(() => {});
        await page.waitForTimeout(1200);
      }
      const chatText = await page.locator('body').innerText();
      check('after reload: chat history persists', /castle on a cloud/i.test(chatText), page.url() + ' — ' + chatText.slice(0, 200));
      check('…with the photo it was sent with', (await page.locator('aside[aria-label="Orb"] [aria-label="Photo"] img').count()) === 1);
      await page.screenshot({ path: `${OUT}/${label}-5-reloaded.png` });

      // Visitor: a fresh context sees the world read-only with the orb collapsed.
      const vctx = await browser.newContext({ viewport });
      await routeCdn(vctx);
      const v = await vctx.newPage();
      v.setDefaultNavigationTimeout(120000);
      v.setDefaultTimeout(90000);
      await v.goto(`${BASE}${pathname}`, { waitUntil: 'domcontentloaded' });
      await v.waitForTimeout(6000);
      await v.screenshot({ path: `${OUT}/${label}-6-visitor.png` });
      const vworld = await v.evaluate(async (wid) => (await fetch(`/api/worlds/${wid}`, { headers: { 'x-orb-device': localStorage.getItem('orb:device') || '' } }).then((r) => r.json())).world, id);
      check('visitor cannot edit', vworld && vworld.canEdit === false);
      await vctx.close();
    }

    // Explore
    await page.goto(BASE + '/explore', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${OUT}/${label}-7-explore.png` });
    check('explore renders', /Explore/.test(await page.locator('body').innerText()));

    // Links from the open-source games' repositories (src/state/links.ts), as someone new to Orb.
    const gctx = await browser.newContext({ viewport, hasTouch: label === 'mobile', isMobile: label === 'mobile' });
    await routeCdn(gctx);
    const g = await gctx.newPage();
    g.setDefaultNavigationTimeout(120000);
    g.setDefaultTimeout(90000);
    g.on('pageerror', (e) => errors.push('pageerror (links): ' + e.message));
    await g.goto(`${BASE}/orbworlds/star-runner?remix&utm_source=github&utm_campaign=star-runner`, { waitUntil: 'domcontentloaded' });
    const copy = g.getByRole('button', { name: 'Remix', exact: true });
    check('?remix: the game opens with its chat and Remix', await copy.waitFor({ timeout: 60000 }).then(() => true, () => false));
    check('…and the link leaves the address', !new URL(g.url()).searchParams.has('remix') && new URL(g.url()).pathname === '/orbworlds/star-runner', g.url());
    await g.screenshot({ path: `${OUT}/${label}-8-remix-link.png` });
    await copy.click();
    let copied = '';
    for (let i = 0; i < 30 && !copied; i++) {
      await g.waitForTimeout(1000);
      const p = new URL(g.url()).pathname;
      if (WORLD_URL.test(p) && !p.startsWith('/orbworlds/')) copied = p;
    }
    check('…one tap makes their own copy', !!copied, g.url());
    await g.goto(`${BASE}/?import=github.com/someone/bedwars`, { waitUntil: 'domcontentloaded' });
    const repoField = g.getByLabel('GitHub repository link');
    check('?import: the You tab opens with the repository to import', await repoField.waitFor({ timeout: 60000 }).then(async () => (await repoField.inputValue()) === 'https://github.com/someone/bedwars', () => false));
    check('…and the link leaves the address', !new URL(g.url()).searchParams.has('import'), g.url());
    await g.screenshot({ path: `${OUT}/${label}-9-import-link.png` });
    await gctx.close();

    check('no page errors', errors.length === 0, errors.slice(0, 5));
    await ctx.close();
  }
} finally {
  await browser.close();
  await stopNext(server);
}
finish();
