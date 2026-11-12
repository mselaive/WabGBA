import { defineConfig } from 'vite';

// mGBA usa hilos (SharedArrayBuffer): la página tiene que estar aislada entre orígenes.
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { port: 5175, strictPort: true, headers },
  preview: { port: 5175, strictPort: true, headers },
  optimizeDeps: { exclude: ['@thenick775/mgba-wasm'] },
  worker: { format: 'es' },
  build: { target: 'esnext' },
});
