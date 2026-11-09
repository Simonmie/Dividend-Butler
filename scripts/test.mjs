import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'dividend-tests-'));
try {
  await build({ entryPoints: ['tests/core.test.ts'], outfile: join(directory, 'core.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs' });
  const result = spawnSync(process.execPath, ['--test', join(directory, 'core.cjs')], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
