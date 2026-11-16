import { services as configured } from './services.config.js';

// Upsert services from the config. Never overwrites the admin-controlled `enabled` flag.
export async function seedServices(models) {
  const { Service } = models;
  for (const s of configured) {
    const { key, ...fields } = s;
    await Service.updateOne(
      { key },
      { $set: { ...fields, internal: s.internal ?? null, public: s.public ?? null }, $setOnInsert: { enabled: true } },
      { upsert: true },
    );
  }
  return configured.length;
}
