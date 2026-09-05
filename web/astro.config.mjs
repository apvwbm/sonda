// @ts-check
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// Static output to web/dist, which is exactly where Fastify looks for it.
// No adapter, no integrations, no client router: one page, one script.
export default defineConfig({
  outDir: './dist',
  build: { format: 'file' },
  vite: { plugins: [tailwindcss()] },
});
