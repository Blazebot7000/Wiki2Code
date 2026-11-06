import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let electronDir;
try {
  electronDir = dirname(require.resolve('electron/package.json'));
} catch {
  // Electron is not installed (for example a production-only install).
  process.exit(0);
}

const marker = join(electronDir, 'path.txt');
if (existsSync(marker)) {
  process.exit(0);
}

console.log('[wiki2code] downloading the Electron runtime…');
execFileSync(process.execPath, [join(electronDir, 'install.js')], {
  stdio: 'inherit',
});
