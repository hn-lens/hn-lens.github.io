import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// SINGLEFILE=1 builds one self-contained index.html openable via file:// (see
// scripts/inline.mjs). It stubs the WASM/worker-based AI libs, which can't run
// from file://. The default build keeps them code-split for the hosted site.
const singlefile = process.env.SINGLEFILE === '1';
const stub = fileURLToPath(new URL('./src/lib/models/_stub_ml.ts', import.meta.url));

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: singlefile
      ? {
          '@huggingface/transformers': stub,
          '@mlc-ai/web-llm': stub,
        }
      : {},
  },
  build: {
    target: 'esnext', // web-llm / transformers.js use top-level await + wasm
    ...(singlefile
      ? {
          cssCodeSplit: false,
          assetsInlineLimit: 100_000_000,
          rollupOptions: { output: { inlineDynamicImports: true } },
        }
      : {}),
  },
  optimizeDeps: {
    // Heavy ML deps are loaded lazily via dynamic import; don't prebundle them.
    exclude: ['@huggingface/transformers', '@mlc-ai/web-llm'],
  },
});
