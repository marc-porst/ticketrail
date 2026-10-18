import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: false,
  splitting: false,
  external: ['chokidar'],
  banner: { js: '#!/usr/bin/env node' },
});
