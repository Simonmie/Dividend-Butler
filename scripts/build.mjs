import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs',
    bundle: true, platform: 'node', target: 'node22', format: 'cjs',
    external: ['vscode'], minify: true, legalComments: 'eof'
  }),
  build({
    entryPoints: ['webview/main.ts'], outfile: 'dist/panel.js',
    bundle: true, platform: 'browser', target: 'es2022', format: 'iife',
    define: { __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false', 'process.env.NODE_ENV': '"production"' },
    minify: true, legalComments: 'eof'
  })
]);
console.log('扩展和面板构建完成');
