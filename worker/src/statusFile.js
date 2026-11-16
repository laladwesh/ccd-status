import fs from 'node:fs/promises';
import path from 'node:path';
import { cfg } from './config.js';

// Atomic write (tmp + rename) so nginx never serves a half-written status.json.
export async function writeStatusFile(snapshot) {
  const file = path.join(cfg.statusDir, 'status.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(cfg.statusDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(snapshot));
  await fs.rename(tmp, file);
}

// Docker HEALTHCHECK reads this file's age. Independent of the database on purpose.
export const writeHeartbeat = () =>
  fs.writeFile(path.join(cfg.statusDir, 'heartbeat'), String(Date.now())).catch(() => {});
