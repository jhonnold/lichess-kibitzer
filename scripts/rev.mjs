// postbuild: write the git sha the app was built from to build/rev, read at boot for kibitzer_build_info.
// The service user can't run git on the checkout (safe.directory), so the sha is captured at build time.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

let rev = 'unknown';
try {
  rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  /* not a git checkout, or no git: keep "unknown" */
}
mkdirSync('build', { recursive: true });
writeFileSync('build/rev', `${rev}\n`);
