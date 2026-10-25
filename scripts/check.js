import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) check(file);
    else if (file.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const directory of ['api', 'server', 'public', 'scripts', 'tests']) check(directory);
const config = spawnSync(process.execPath, ['--check', 'vite.config.js'], { stdio: 'inherit' });
if (config.status !== 0) process.exit(config.status || 1);
console.log('JavaScript syntax checks passed.');
