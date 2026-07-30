// In-app user profile (/user/:id) test — guards C4 + the profile comments/AI additions:
// author names across the app link to an in-app profile page built from the CORS-enabled
// Firebase user API. Verifies: the profile shows username + karma + member-since + bio; a
// Stories/Comments toggle (with counts) shows the user's STORY submissions AND COMMENTS
// (comments were previously not shown at all); an on-demand AI "About this user" persona
// summary is HIDDEN without AI configured and WORKS with a cloud key (Gemini mocked); an
// "on HN" external link; an unknown-user state; and a feed card's author name navigating to
// the profile. All HN + provider APIs mocked.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4173/';
const now = Math.floor(Date.now() / 1000);

const USER = { id: 'testuser', created: now - 5 * 365 * 86400, karma: 4242, about: '<p>I build <b>things</b> on the web.</p><p>Blog: https://example.com/blog</p>', submitted: [91, 92, 93, 94] };
// A user with too little activity to summarize (1 tiny comment) — the persona MUST refuse, and a
// refusal must show NO "Based on …" provenance (nothing was sent to the model).
const THIN_USER = { id: 'thinuser', created: now - 100000, karma: 3, submitted: [95] };
// A user summarizable but NEVER summarized elsewhere in this test — so the cross-profile RACE check
// gets a genuine cache MISS (a real in-flight generation), not the instant IndexedDB-cache return
// that testuser would give after its earlier summary.
const RACE_USER = { id: 'raceuser', created: now - 300 * 86400, karma: 55, submitted: [96, 97] };
// A summarizable user reserved for the FAILURE path (never summarized elsewhere → a real cache-miss
// generation that the mocked provider 500s), so the error branch is genuinely exercised.
const ERROR_USER = { id: 'erroruser', created: now - 200 * 86400, karma: 33, submitted: [98, 99] };
const ITEMS = {
  91: { id: 91, type: 'story', by: 'testuser', title: 'My first story about widgets', url: 'https://ex.com/91', score: 120, descendants: 8, time: now - 86400 },
  92: { id: 92, type: 'story', by: 'testuser', title: 'A second story about gadgets', url: 'https://ex.com/92', score: 90, descendants: 3, time: now - 172800 },
  93: { id: 93, type: 'comment', by: 'testuser', text: '<p>just a comment, not a story</p>', time: now - 200000 },
  94: { id: 94, type: 'story', by: 'testuser', title: 'A third story about doohickeys', url: 'https://ex.com/94', score: 60, descendants: 1, time: now - 259200 },
  95: { id: 95, type: 'comment', by: 'thinuser', text: '<p>ok</p>', time: now - 1000 },
  96: { id: 96, type: 'story', by: 'raceuser', title: 'Distributed systems war stories from production', url: 'https://ex.com/96', score: 80, descendants: 4, time: now - 400000 },
  97: { id: 97, type: 'story', by: 'raceuser', title: 'Why we rewrote our scheduler in Rust', url: 'https://ex.com/97', score: 70, descendants: 2, time: now - 500000 },
  98: { id: 98, type: 'story', by: 'erroruser', title: 'Notes on building a small compiler', url: 'https://ex.com/98', score: 40, descendants: 3, time: now - 600000 },
  99: { id: 99, type: 'story', by: 'erroruser', title: 'A deep dive into hash map internals', url: 'https://ex.com/99', score: 35, descendants: 1, time: now - 700000 },
};
// A feed story by testuser, to test author-link navigation from a card.
const FEED = { 501: { id: 501, type: 'story', by: 'testuser', title: 'Feed story by testuser', url: 'https://ex.com/501', score: 200, descendants: 10, time: now - 3600 } };

const fails = [];
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '\u2713' : '\u2717'} ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  if (!pass) fails.push(name);
};

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const page = ctx.pages()[0] || (await ctx.newPage());
const json = (r, x) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
await page.route(/hacker-news\.firebaseio\.com/, (r) => {
  const u = r.request().url();
  const mu = u.match(/user\/([^.]+)\.json/);
  // A backend outage must be distinguishable from a genuinely-absent user.
  if (mu && mu[1] === 'outageuser') return r.fulfill({ status: 503, contentType: 'text/plain', body: 'upstream error' });
  if (mu) return json(r, mu[1] === 'testuser' ? USER : mu[1] === 'thinuser' ? THIN_USER : mu[1] === 'raceuser' ? RACE_USER : mu[1] === 'erroruser' ? ERROR_USER : null); // unknown users → null (200)
  const mi = u.match(/item\/(\d+)\.json/);
  if (mi) return json(r, ITEMS[mi[1]] ?? FEED[mi[1]] ?? null);
  if (/topstories/.test(u)) return json(r, [501]);
  if (/stories/.test(u)) return json(r, []);
  return json(r, null);
});
await page.route(/hn\.algolia\.com|google\.com\/s2/, (r) => r.fulfill({ status: 200, body: '{}' }));
let geminiFail = false; // when true, generateContent 500s → the cloud client throws (a transient failure)
// Mock the Gemini API so the on-demand persona summary can be tested without WebGPU.
await page.route(/generativelanguage\.googleapis\.com/, async (r) => {
  const u = r.request().url();
  // A deliberate delay so a test can navigate to another profile while a generation is IN FLIGHT
  // (the cross-profile race). Harmless to the success tests (they wait up to 15s).
  if (/:generateContent/.test(u)) {
    // A transient provider failure → the surface shows "Could not summarize…", which must keep a
    // retry control reachable (finding C).
    if (geminiFail) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'rate limited' } }) });
    await new Promise((res) => setTimeout(res, 700));
    return json(r, { candidates: [{ content: { parts: [{ text: 'PERSONA_SUMMARY: builds web things and comments on widgets and gadgets.' }] } }] });
  }
  if (/\/models/.test(u)) return json(r, { models: [{ name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportedGenerationMethods: ['generateContent'] }] });
  return json(r, {});
});

// ---- the profile page ----
await page.goto(`${BASE}#/user/testuser`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /testuser/.test(document.body.innerText), null, { timeout: 20000 });
await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(500);
{
  const body = await page.locator('main').innerText();
  check('profile shows the username', /testuser/.test(body));
  check('profile shows karma', /4,?242\s*karma/i.test(body), body.match(/[\d,]+\s*karma/i)?.[0] ?? '');
  check('profile shows member-since', /member since/i.test(body));
  check('profile shows the bio (sanitized)', /I build things on the web/i.test(body));
  // Bare URLs in the bio are auto-linkified (HN's `about` has no <a> tags) so a reader can
  // click through to the author's blog/socials instead of copy-pasting. (M2 usability fix.)
  const bioLinks = await page.evaluate(() => [...document.querySelectorAll('.hn-html a')].map((a) => a.getAttribute('href')));
  check('bare URLs in the bio are linkified', bioLinks.includes('https://example.com/blog'), JSON.stringify(bioLinks));
  const onHn = await page.getByRole('link', { name: /on HN/i }).getAttribute('href').catch(() => '');
  check('profile offers an "on HN" external link', /news\.ycombinator\.com\/user\?id=testuser/.test(onHn || ''), onHn ?? '');
  const titles = await page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => h.textContent.trim()));
  check('lists the STORY submissions (91, 92, 94)', titles.some((t) => /first story/.test(t)) && titles.some((t) => /second story/.test(t)) && titles.some((t) => /third story/.test(t)), JSON.stringify(titles));
  check('the Stories tab does NOT render the comment (93) as a story card', !titles.some((t) => /just a comment/.test(t)));
}

// ---- Stories / Comments toggle: comments are now shown (previously they weren't) ----
{
  const storiesTab = await page.getByRole('tab', { name: /^Stories/ }).textContent().catch(() => '');
  const commentsTab = await page.getByRole('tab', { name: /^Comments/ }).textContent().catch(() => '');
  check('a Stories tab shows the story count (3)', /Stories\s*\(3\)/.test(storiesTab || ''), storiesTab ?? '');
  check('a Comments tab shows the comment count (1)', /Comments\s*\(1\)/.test(commentsTab || ''), commentsTab ?? '');
  // Switch to Comments → the comment text + a "View discussion" deep-link appear.
  await page.getByRole('tab', { name: /^Comments/ }).click();
  await page.waitForTimeout(300);
  const commentsBody = await page.locator('main').innerText();
  check('Comments tab shows the comment text', /just a comment, not a story/i.test(commentsBody), commentsBody.slice(0, 200));
  const discHref = await page.locator('main a[href="#/item/93"]').first().getAttribute('href').catch(() => '');
  check('each comment links to its discussion (/item/93)', discHref === '#/item/93', discHref ?? '');
  // The counts are a recent SAMPLE, not lifetime totals — the caption must say so (so
  // "Comments (1)" for a prolific user isn't misread as their total).
  check('a "Recent activity" caption clarifies the counts are a sample', /Recent activity/i.test(await page.locator('main').innerText()));
}

// ---- AI "About this user" persona summary: CTA without AI, generator with a cloud key ----
{
  // Default headless state (no cloud key, no WebGPU) → the summary GENERATOR is hidden, but a
  // discoverability CTA to set up AI is shown (mirrors the discussion page; the feature isn't
  // invisible to no-WebGPU users).
  const noAi = await page.locator('main').innerText();
  check('the "About this user" generator is hidden when no AI is configured', !/About this user/i.test(noAi));
  check('a "set up AI" CTA is shown on the profile when AI is off', /Set up an AI summary/i.test(noAi), noAi.slice(0, 120));
  const ctaHref = await page.locator('main a[href="#/settings?section=ai-summaries"]').first().getAttribute('href').catch(() => '');
  check('the profile AI CTA deep-links to the Settings AI section', ctaHref === '#/settings?section=ai-summaries', ctaHref ?? '');

  // Configure a Gemini key → the card appears; clicking Summarize returns the mocked text.
  await page.evaluate(() => {
    const cur = window.__hnlens.prefs.getState();
    cur.set({ llmProvider: 'gemini', apiKeys: { ...cur.apiKeys, gemini: 'g-key' } });
  });
  await page.goto(`${BASE}#/user/testuser`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /About this user/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  check('AI "About this user" card appears once a cloud key is set', /About this user/i.test(await page.locator('main').innerText()));
  await page.getByRole('button', { name: /Summarize their activity/i }).click();
  await page.waitForFunction(() => /PERSONA_SUMMARY/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  check('clicking Summarize shows the generated persona summary', /PERSONA_SUMMARY/.test(await page.locator('main').innerText()));
  check('the summary offers a "View request" transparency control', (await page.getByRole('button', { name: /View request/i }).count()) >= 1);
  // Provenance is EARNED + accurate: a real summary shows "Based on <SENT count>" — testuser sends
  // 3 stories + 1 comment (all fit the persona budget). (Guards the User.tsx rendered line, which the
  // function-level aiguardtest never exercised.)
  {
    const main = await page.locator('main').innerText();
    check('persona provenance appears on a real summary', /Based on \d+ recent stor/i.test(main), main.match(/Based on[^\n]*/i)?.[0] ?? '(none)');
    check('persona provenance counts the SENT activity (3 stories + 1 comment)', /Based on 3 recent stories \+ 1 comment/i.test(main), main.match(/Based on[^\n]*/i)?.[0] ?? '(none)');
  }
  // A thin user MUST refuse — and a refusal (no model ran) must show NO "Based on" provenance line.
  await page.goto(`${BASE}#/user/thinuser`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /About this user/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  await page.getByRole('button', { name: /Summarize their activity/i }).click().catch(() => {});
  await page.waitForFunction(() => /Not enough recent activity|Based on \d+ recent/i.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  {
    const main = await page.locator('main').innerText();
    check('thin-user persona REFUSES (no fabricated bio)', /Not enough recent activity/i.test(main), main.slice(0, 100));
    check('a refusal shows NO "Based on" provenance line (nothing was sent)', !/Based on \d+ recent/i.test(main), main.match(/Based on[^\n]*/i)?.[0] ?? '(none)');
    // A deterministic refusal offers no useful controls — Refresh re-refuses, "Edit prompt" is
    // inoperative (a thin-input refusal short-circuits before any prompt is used). Row hidden.
    check('a refusal hides the controls row (no Refresh / Edit prompt)', !/Refresh|Edit prompt/i.test(main), main.match(/Refresh|Edit prompt/i)?.[0] ?? '(clean)');
  }
  // ---- CROSS-PROFILE RACE: an in-flight generation must not land on the NEXT profile ----
  // Start a summary on raceuser (a genuine cache MISS → real in-flight fetch), then navigate
  // in-app (no reload) to thinuser while the mocked generation is still running (700ms delay). The
  // superseded result must be discarded — thinuser is a refuse-only profile, so if PERSONA_SUMMARY
  // appears there, raceuser's run wrote its result onto the wrong profile.
  {
    await page.goto(`${BASE}#/user/raceuser`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /About this user/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    // Wait for the generation request to actually be ISSUED before navigating, so the fetch is
    // provably in flight (deterministic — not a fixed sleep).
    const genIssued = page.waitForRequest(/:generateContent/, { timeout: 8000 }).catch(() => null);
    await page.getByRole('button', { name: /Summarize their activity/i }).click();
    await genIssued;
    await page.evaluate(() => { window.location.hash = '#/user/thinuser'; }); // in-app nav, no reload
    await page.waitForFunction(() => /3 karma/.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500); // the superseded raceuser generation resolves within this window
    const raceMain = await page.locator('main').innerText();
    check('an in-flight persona summary does NOT land on the next profile (cross-profile race)', !/PERSONA_SUMMARY/.test(raceMain), raceMain.match(/PERSONA_SUMMARY[^\n]*/)?.[0] ?? '(clean)');
  }
  // ---- FAILED persona generation KEEPS a retry reachable (finding C) ----
  // A transient provider error must not dead-end the profile: the retry control (Refresh) stays,
  // while the basis line + "AI-generated" caveat stay OFF (nothing ran successfully).
  {
    geminiFail = true;
    await page.goto(`${BASE}#/user/erroruser`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /About this user/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    await page.getByRole('button', { name: /Summarize their activity/i }).click().catch(() => {});
    await page.waitForFunction(() => /Could not summarize/i.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    const main = await page.locator('main').innerText();
    check('persona error shows the honest "could not" text', /Could not summarize/i.test(main), main.match(/Could not[^\n]*/i)?.[0] ?? '(none)');
    check('persona error KEEPS a retry control (Refresh)', /Refresh/i.test(main), main.match(/Refresh/i)?.[0] ?? '(missing)');
    check('persona error shows NO "Based on"/AI-generated (nothing ran)', !/Based on \d+ recent|AI-generated/i.test(main), (main.match(/Based on \d+ recent[^\n]*|AI-generated[^\n]*/i) || ['(clean)'])[0]);
    geminiFail = false;
  }
  // Reset provider so later sections use the default local state.
  await page.evaluate(() => window.__hnlens.prefs.getState().set({ llmProvider: 'local', apiKeys: { gemini: '', openai: '', anthropic: '' } }));
}

// ---- unknown user → not-found state ----
await page.goto(`${BASE}#/user/nobody`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /User not found|no Hacker News user/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
check('unknown user shows a "User not found" state', /User not found/i.test(await page.locator('main').innerText()));

// ---- OUTAGE (503) must NOT look like a missing user; it must offer Retry ----
await page.goto(`${BASE}#/user/outageuser`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /couldn.t load|try again|retry|not found/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
{
  const outage = await page.locator('main').innerText();
  check('a profile OUTAGE shows a "couldn\u2019t load" error, not "User not found"', /couldn.t load|couldn.t reach|try again/i.test(outage) && !/User not found/i.test(outage), outage.replace(/\s+/g, ' ').slice(0, 140));
  check('a profile outage offers a Retry control', (await page.getByRole('button', { name: /retry|try again/i }).count()) >= 1, '');
}

// ---- a feed card's author name navigates to the in-app profile ----
await page.goto(`${BASE}#/?feed=top`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('article', { timeout: 15000 });
await page.waitForTimeout(400);
await page.locator('article a[href="#/user/testuser"]').first().click();
await page.waitForFunction(() => /karma/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
check('clicking a card author name opens the in-app profile', /#\/user\/testuser/.test(page.url()) && /karma/i.test(await page.locator('main').innerText()), page.url());

await b.close();
console.log(`\n${fails.length === 0 ? 'RESULT: USER PROFILE PASS \u2713' : `RESULT: ${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
