import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

export default defineConfig(({ command }) => {
  const builtAt = new Date().toISOString();
  const build = { version, id: command === 'build' ? `${builtAt.replace(/\D/g, '')}-${randomBytes(3).toString('hex')}` : 'dev', builtAt };
  const buildIdentity: Plugin = {
    name: 'nexus-build-identity',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'nexus-build', content: build.id }, injectTo: 'head' }],
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify(build) });
      // Stamp the public worker itself: old query-string registrations also
      // fetch new worker bytes and install the actually deployed build.
      const worker = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: worker.replace('/* __NEXUS_BUILD__ */ null', JSON.stringify(build)) });
    },
  };
  return {
  plugins: [react(), buildIdentity],
  define: { __NEXUS_BUILD_INFO__: JSON.stringify(build) },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
    watch: { ignored: ['**/tests/artifacts/**', '**/.work/**', '**/.dashboard/**'] },
  },
  preview: { proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } } },
  };
});
