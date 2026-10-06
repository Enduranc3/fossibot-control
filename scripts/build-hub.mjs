import { build } from 'esbuild';

await build({
  entryPoints: ['hub/src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/hub/hub.mjs',
  // ws loads these optional native addons inside try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS; give the ESM bundle a require().
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { __FOSSIBOT_VERSION__: JSON.stringify(process.env.FOSSIBOT_VERSION ?? 'dev') },
  logLevel: 'info',
});
