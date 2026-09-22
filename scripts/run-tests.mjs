// T04: thin wrapper so scripts/test.ps1 can run the full suite through
// the shared node invocation helper. The glob form is required: passing
// the bare directory fails discovery on Windows, while the runner
// expands the glob itself (no shell involved).
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleRoot = fileURLToPath(new URL('..', import.meta.url));

const child = spawn(process.execPath, ['--test', join(moduleRoot, 'tests', '*.test.mjs')], {
  cwd: moduleRoot,
  windowsHide: true,
  stdio: 'inherit',
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
child.on('error', () => {
  process.exitCode = 1;
});
