import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'dividend-host-'));
const executable = process.env.DIVIDEND_TEST_EDITOR || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
try {
  const tests = join(directory, 'suite.cjs');
  await build({ entryPoints: ['tests/host.test.ts'], outfile: tests, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'] });
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: resolve('.'),
    extensionTestsPath: tests,
    launchArgs: ['--user-data-dir', join(directory, 'profile'), '--extensions-dir', join(directory, 'extensions'),
      '--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry']
  });
} finally { await rm(directory, { recursive: true, force: true }); }
