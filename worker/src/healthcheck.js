// Docker HEALTHCHECK: healthy while status.json was rewritten in the last 3 minutes.
import fs from 'node:fs';
import path from 'node:path';

try {
  const age = Date.now() - fs.statSync(path.join(process.env.STATUS_DIR || '/data', 'status.json')).mtimeMs;
  process.exit(age < 180000 ? 0 : 1);
} catch {
  process.exit(1);
}
