import mongoose from 'mongoose';
import { cfg } from './config.js';
import { createModels } from '../../shared/models.js';
import { seedServices } from '../../shared/seed.js';

await mongoose.connect(cfg.mongoUri, { serverSelectionTimeoutMS: 8000 });
const n = await seedServices(createModels(mongoose));
console.log(`Seeded ${n} services from shared/services.config.js`);
await mongoose.disconnect();
