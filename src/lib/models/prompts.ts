// Default SYSTEM INSTRUCTIONS per summary type — sent as the system message on every LLM
// call (local + cloud). A user can override these in Settings (prefs.systemPrompts). Kept in
// a dependency-light module (no ML imports) so Settings can show/reset them without pulling
// the lazy llm.ts orchestrator into the main bundle.
export const DEFAULT_SYSTEM: { tldr: string; thread: string } = {
  tldr: 'You write a single-sentence TL;DR of a Hacker News item using ONLY the provided content. Output only the sentence — no preamble, no markdown.',
  thread:
    'You summarize a Hacker News discussion for someone who has not read it, using ONLY the provided article and comments. Be specific, factual, and concise; never invent facts, numbers, or claims.',
};
