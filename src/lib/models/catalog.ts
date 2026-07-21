// Lightweight model catalogs — safe to import statically anywhere without
// pulling in the heavy ML runtimes (which are loaded via dynamic import).

// Small instruct models available in WebLLM 0.2.84 that are verified to produce
// coherent output in-browser. The "~GB" is the in-browser memory footprint.
// (Gemma 3 is intentionally excluded: WebLLM 0.2.84 mis-handles its sliding-window
// attention config, producing garbage output.)
// Llama 3.2 1B is the smallest model that RELIABLY produces grounded summaries
// in-browser (~0.9 GB, under 1 GB). Smaller ones (Qwen2.5 0.5B, SmolLM2 360M)
// were eval'd and rejected: they hallucinate, drop the format, or echo the prompt.
export const LLM_MODELS: Array<{ id: string; label: string }> = [
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B — recommended (~0.9 GB)' },
];

export const EMBEDDING_MODELS: Array<{ value: string; label: string }> = [
  { value: 'Xenova/all-MiniLM-L6-v2', label: 'all-MiniLM-L6-v2 — 384d, fast (default)' },
  { value: 'Xenova/bge-small-en-v1.5', label: 'bge-small-en-v1.5 — 384d, higher quality' },
  { value: 'Xenova/gte-small', label: 'gte-small — 384d' },
];
