# Security Policy

HN Lens is a **static, client-side** web app. It has no backend server and no database:
everything runs in your browser, and all data (reading history, settings, cached stories,
model weights) is stored locally in IndexedDB and localStorage. This keeps the security
surface small — there is no server to compromise and no shared user data.

## What data leaves your browser

By default, the app talks only to the public Hacker News data APIs
(`hacker-news.firebaseio.com`, `hn.algolia.com`) — plus one cosmetic exception: story
**favicons** are loaded from Google's public favicon service
(`google.com/s2/favicons?domain=…`), so the domains of stories shown to you are visible to
that service. You can turn this off in **Settings → Privacy** ("Load story favicons…") — the
app then renders letter monograms only and never contacts that service. Your reading
activity, ranking, personalization, and models all run and stay on your device.

Two optional, off-by-default features send more data elsewhere, and each is clearly
labelled in Settings:

- **Linked-article text** — fetches article bodies through a public CORS proxy to feed
  summaries and ranking. Enabling it sends the URLs you engage with to that proxy.
- **Cloud LLM summaries** — if you supply your own API key for a cloud provider
  (Gemini / OpenAI / Anthropic), summary content and your key are sent to that provider.
  Keys are stored only in your browser's localStorage and are never committed or sent
  anywhere else.

## Reporting a vulnerability

Please report security issues privately via GitHub's **"Report a vulnerability"** button
(Security → Advisories) on this repository rather than opening a public issue. Include
steps to reproduce and the affected version or commit. We'll acknowledge the report and
work on a fix; please allow a reasonable window before public disclosure.

## Supported versions

This is an actively-developed single-branch project; fixes land on `main` and deploy
automatically. Please report issues against the latest deployed version.
