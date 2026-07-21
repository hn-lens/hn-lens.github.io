// Inspect + free browser-cached model weights (WebLLM LLMs, Transformers.js
// embeddings). Both cache their (large) shards via the Cache Storage API, so we
// can list + delete them generically — no need to import the heavy ML runtimes.
import { LLM_MODELS, EMBEDDING_MODELS } from './catalog';

export interface CachedModel {
  id: string;
  label: string;
  kind: 'llm' | 'embedding';
  bytes: number;
  entries: Array<{ cache: string; url: string }>;
}

export interface StorageReport {
  models: CachedModel[];
  otherBytes: number; // cached bytes not attributable to a known model
  usage: number; // navigator.storage.estimate().usage
  quota: number;
  supported: boolean;
}

async function scanCaches(): Promise<Array<{ cache: string; url: string; bytes: number }>> {
  if (typeof caches === 'undefined') return [];
  const out: Array<{ cache: string; url: string; bytes: number }> = [];
  for (const name of await caches.keys()) {
    const c = await caches.open(name);
    for (const req of await c.keys()) {
      let bytes = 0;
      try {
        const res = await c.match(req);
        const len = res?.headers.get('content-length');
        bytes = len ? Number(len) : 0;
      } catch {
        bytes = 0;
      }
      out.push({ cache: name, url: req.url, bytes });
    }
  }
  return out;
}

export async function getStorageReport(): Promise<StorageReport> {
  const supported = typeof caches !== 'undefined';
  const entries = await scanCaches();
  const catalog: Array<{ id: string; label: string; kind: 'llm' | 'embedding' }> = [
    ...LLM_MODELS.map((m) => ({ id: m.id, label: m.label, kind: 'llm' as const })),
    ...EMBEDDING_MODELS.map((m) => ({ id: m.value, label: m.label, kind: 'embedding' as const })),
  ];

  const claimed = new Set<string>();
  const models: CachedModel[] = [];
  for (const m of catalog) {
    const mine = entries.filter((e) => e.url.includes(m.id));
    if (!mine.length) continue;
    mine.forEach((e) => claimed.add(e.cache + '\u0000' + e.url));
    models.push({
      id: m.id,
      label: m.label,
      kind: m.kind,
      bytes: mine.reduce((s, e) => s + e.bytes, 0),
      entries: mine.map((e) => ({ cache: e.cache, url: e.url })),
    });
  }
  const otherBytes = entries
    .filter((e) => !claimed.has(e.cache + '\u0000' + e.url))
    .reduce((s, e) => s + e.bytes, 0);

  let usage = 0;
  let quota = 0;
  try {
    const est = await navigator.storage?.estimate?.();
    usage = est?.usage ?? 0;
    quota = est?.quota ?? 0;
  } catch {
    /* not available */
  }

  return { models: models.sort((a, b) => b.bytes - a.bytes), otherBytes, usage, quota, supported };
}

/** Delete a cached model's shards from Cache Storage. Returns entries removed. */
export async function removeCachedModel(model: CachedModel): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  let removed = 0;
  for (const { cache, url } of model.entries) {
    try {
      const c = await caches.open(cache);
      if (await c.delete(url)) removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
