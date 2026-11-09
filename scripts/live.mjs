import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'dividend-live-'));
try {
  const path = join(directory, 'providers.cjs');
  await build({ entryPoints: ['src/providers.ts'], outfile: path, bundle: true, platform: 'node', format: 'cjs' });
  const provider = (await import(pathToFileURL(path).href)).default;
  for (const code of ['510880', '515180', '159905']) {
    const bars = await provider.getBars(code);
    const result = await provider.getDividends(code);
    if (bars.length < 200 || result.dividends.length < 3) throw new Error(`${code} 数据覆盖不足`);
    console.log(JSON.stringify({ code, barCount: bars.length, latest: bars.at(-1), dividends: result.dividends.length, lastDividend: result.dividends.at(-1), splits: result.splits }, null, 2));
  }
} finally { await rm(directory, { recursive: true, force: true }); }
