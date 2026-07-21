import { create } from 'zustand';

export type ModelStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

// 'unknown' until we've actually asked the browser for a GPU adapter (the probe is
// async). Optimistic: treat 'unknown' as usable so controls appear immediately.
export type WebgpuStatus = 'unknown' | 'available' | 'unavailable';

export interface ProviderState {
  status: ModelStatus;
  progress: number; // 0..1
  message: string;
}

interface ModelStore {
  embeddings: ProviderState;
  llm: ProviderState;
  webgpu: WebgpuStatus;
  setEmbeddings: (p: Partial<ProviderState>) => void;
  setLlm: (p: Partial<ProviderState>) => void;
  setWebgpu: (s: WebgpuStatus) => void;
}

const initial: ProviderState = { status: 'idle', progress: 0, message: '' };

export const useModelStore = create<ModelStore>((set) => ({
  embeddings: initial,
  llm: initial,
  webgpu: 'unknown',
  setEmbeddings: (p) => set((s) => ({ embeddings: { ...s.embeddings, ...p } })),
  setLlm: (p) => set((s) => ({ llm: { ...s.llm, ...p } })),
  setWebgpu: (webgpu) => set({ webgpu }),
}));

// Non-hook setters for use inside lib modules.
export const setEmbeddingsStatus = (p: Partial<ProviderState>) =>
  useModelStore.getState().setEmbeddings(p);
export const setLlmStatus = (p: Partial<ProviderState>) => useModelStore.getState().setLlm(p);

// Fast synchronous check: is the WebGPU *API* present? Used for embeddings device
// selection (webgpu vs wasm fallback) where a wrong guess is harmless.
export const webgpuAvailable = (): boolean =>
  typeof navigator !== 'undefined' && 'gpu' in navigator;

type GpuLike = { requestAdapter: () => Promise<unknown> };
let webgpuProbe: Promise<boolean> | null = null;

/**
 * Actually request a GPU adapter — not just check the API exists — and cache the
 * result in the store. On a browser with the WebGPU API but no usable adapter
 * (blocklisted GPU, acceleration off), `navigator.gpu` is present yet
 * `requestAdapter()` yields null; without this probe the AI controls would render
 * and then error on click instead of showing the graceful "needs WebGPU" message.
 */
export function probeWebgpu(): Promise<boolean> {
  if (webgpuProbe) return webgpuProbe;
  webgpuProbe = (async () => {
    const gpu =
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & { gpu?: GpuLike }).gpu
        : undefined;
    if (!gpu) {
      useModelStore.getState().setWebgpu('unavailable');
      return false;
    }
    try {
      const adapter = await gpu.requestAdapter();
      const ok = !!adapter;
      useModelStore.getState().setWebgpu(ok ? 'available' : 'unavailable');
      return ok;
    } catch {
      useModelStore.getState().setWebgpu('unavailable');
      return false;
    }
  })();
  return webgpuProbe;
}
