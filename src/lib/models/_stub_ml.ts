// Stub used only for the single-file (file://) build. The real Transformers.js /
// WebLLM runtimes rely on WASM + web workers, which browsers block on file://.
// In the single-file build the on-device AI features degrade gracefully to this
// stub; the full experience runs on the hosted (http/https) build.

const MESSAGE =
  'On-device AI (embeddings/LLM) needs the site served over http(s). Open the deployed site (GitHub Pages) or run `npm run preview`.';

export const env: Record<string, unknown> = {};

export function pipeline(): never {
  throw new Error(MESSAGE);
}

export function CreateMLCEngine(): never {
  throw new Error(MESSAGE);
}
