import { build } from 'esbuild';

await build({
  entryPoints: ['web/src/sw.ts'],
  bundle: true,
  format: 'iife',
  target: 'safari16',
  outfile: 'dist/web/sw.js',
  logLevel: 'info',
});
