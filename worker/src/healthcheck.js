// Docker HEALTHCHECK: healthy while the heartbeat file is younger than 120 s.
// The worker rewrites it after every completed check loop (every ~5 s); a hung loop stops it.
import fs from 'node:fs';
import path from 'node:path';

try {
  const age = Date.now() - fs.statSync(path.join(process.env.STATUS_DIR || '/data', 'heartbeat')).mtimeMs;
  process.exit(age < 120000 ? 0 : 1);
} catch {
  process.exit(1);
}
