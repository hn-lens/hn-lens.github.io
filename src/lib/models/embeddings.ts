import { db } from '../db';
import { stripHtml } from '../html';
import { getCachedArticle } from '../hn/article';
import { setEmbeddingsStatus, webgpuAvailable } from './registry';
import type { HnItem } from '../../types';

interface Tensor {
  tolist(): number[][];
}
type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<Tensor>;

interface ProgressInfo {
  status?: string;
  progress?: number;
  file?: string;
}

let extractorPromise: Promise<Extractor> | null = null;
let loadedModel = '';

async function getExtractor(model: string): Promise<Extractor> {
  if (extractorPromise && loadedModel === model) return extractorPromise;
  loadedModel = model;
  setEmbeddingsStatus({ status: 'loading', progress: 0, message: 'Loading embedding model…' });

  extractorPromise = (async () => {
    const tf = await import('@huggingface/transformers');
    tf.env.allowLocalModels = false;
    const device = webgpuAvailable() ? 'webgpu' : 'wasm';
    const pipe = (await tf.pipeline('feature-extraction', model, {
      device,
      progress_callback: (p: ProgressInfo) => {
        if (typeof p.progress === 'number') {
          setEmbeddingsStatus({
            status: 'loading',
            progress: p.progress / 100,
            message: `Downloading ${p.file ?? 'model'}…`,
          });
        }
      },
    })) as unknown as Extractor;
    setEmbeddingsStatus({ status: 'ready', progress: 1, message: `Ready (${device})` });
    return pipe;
  })();

  try {
    return await extractorPromise;
  } catch (err) {
    extractorPromise = null;
    setEmbeddingsStatus({ status: 'error', progress: 0, message: String(err) });
    throw err;
  }
}

export function textForItem(item: HnItem): string {
  const title = stripHtml(item.title) || '';
  const body = stripHtml(item.text) || '';
  return `${title}. ${body}`.slice(0, 512);
}

/** The exact text embedded for an item. With a linked-article body (opt-in), it's
 *  folded in — bounded larger — so the embedding (and thus `relevance`) reflects the
 *  FULL text, not just the title + HN self-text. Exported for tests. */
export function embedTextForItem(item: HnItem, article = ''): string {
  const title = stripHtml(item.title) || '';
  const body = stripHtml(item.text) || '';
  const base = `${title}. ${body}`.trim();
  const art = article ? stripHtml(article).trim() : '';
  return art ? `${base}. ${art}`.slice(0, 1500) : base.slice(0, 512);
}

/** Dot product of two vectors (== cosine when both are unit-normalized). */
export function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** Return a unit-normalized copy of a vector (zero-safe). */
export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / norm);
}

/** Trigger model download / initialization without needing items. */
export async function warmupEmbeddings(model: string): Promise<void> {
  await embedTexts(model, ['hello world']);
}

export async function embedTexts(model: string, texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor(model);
  const out: number[][] = [];
  const BATCH = 32;
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    const t = await extractor(chunk, { pooling: 'mean', normalize: true });
    for (const row of t.tolist()) out.push(row);
  }
  return out;
}

/**
 * Ensure embeddings exist (cached in IndexedDB) for the given items. When
 * `withArticle` is set (the reader-proxy opt-in), an item that has a cached article
 * body is embedded WITH that body folded in, so `relevance` reflects the full text.
 *
 * Re-embed only when: the row is missing, the model changed, or we now want the
 * article and the row was explicitly embedded WITHOUT it (`withArticle === false`).
 * The strict `=== false` matters: rows that predate this field (e.g. seeded by the
 * hermetic proof) are `undefined` and are left as-is — never force a live re-embed.
 */
export async function ensureItemEmbeddings(
  model: string,
  items: HnItem[],
  opts: { withArticle?: boolean } = {}
): Promise<void> {
  const toEmbed: Array<{ id: number; text: string; withArticle: boolean }> = [];
  for (const it of items) {
    let article = '';
    if (opts.withArticle) {
      try {
        article = (await getCachedArticle(it.id))?.text ?? '';
      } catch {
        article = '';
      }
    }
    const want = !!article;
    const row = await db.embeddings.get(it.id);
    const upToDate = !!row && row.model === model && !(want && row.withArticle === false);
    if (upToDate) continue;
    toEmbed.push({ id: it.id, text: embedTextForItem(it, article), withArticle: want });
  }
  if (!toEmbed.length) return;
  const vecs = await embedTexts(
    model,
    toEmbed.map((t) => t.text)
  );
  await db.embeddings.bulkPut(
    toEmbed.map((t, i) => ({ id: t.id, vec: vecs[i], model, withArticle: t.withArticle }))
  );
}

// Reading-profile similarity for feed ranking now lives in ranking/content.ts
// (with leave-one-out support + contrastive liked/disliked centroids). The
// primitives above (embedTexts, ensureItemEmbeddings, dot, normalize) are the
// shared building blocks it uses.

/** For "more like this" — nearest items to a given item within a candidate set. */
export async function similarItems(
  model: string,
  targetId: number,
  candidates: HnItem[],
  k = 6
): Promise<Array<{ item: HnItem; sim: number }>> {
  await ensureItemEmbeddings(
    model,
    candidates.filter((c) => c.id !== targetId)
  );
  const target = await db.embeddings.get(targetId);
  if (!target) return [];
  const scored: Array<{ item: HnItem; sim: number }> = [];
  for (const c of candidates) {
    if (c.id === targetId) continue;
    const row = await db.embeddings.get(c.id);
    if (!row) continue;
    scored.push({ item: c, sim: dot(target.vec, row.vec) });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k);
}
