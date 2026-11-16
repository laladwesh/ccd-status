// Mongoose models, built from a mongoose instance passed in by the caller so that
// `shared/` has no dependencies of its own (worker and server each bring mongoose).

export function createModels(mongoose) {
  const { Schema } = mongoose;
  const define = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);
  const DAY = 86400;

  const Service = define('Service', new Schema({
    key: { type: String, required: true, unique: true },
    name: String,
    group: String,
    order: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    container: String,
    internal: Schema.Types.Mixed,
    public: Schema.Types.Mixed,
    dependsOnDb: { type: Boolean, default: true },
    quality: { type: String, default: 'basic' },
    intervalSec: Number,
  }, { timestamps: true }));

  // One document per probe result. TTL: 30 days.
  const checkSchema = new Schema({
    serviceKey: { type: String, required: true },
    probeType: { type: String, required: true }, // container | internal | public | tls | dns | gateway | mongo
    ok: Boolean,
    statusCode: Number,
    latencyMs: Number,
    error: String,
    ts: { type: Date, default: Date.now },
  }, { versionKey: false });
  checkSchema.index({ ts: 1 }, { expireAfterSeconds: 30 * DAY });
  checkSchema.index({ serviceKey: 1, probeType: 1, ts: -1 });
  const Check = define('Check', checkSchema);

  // Per-day, per-service counters. TTL: 365 days from the day's start.
  const rollupSchema = new Schema({
    serviceKey: { type: String, required: true },
    day: { type: String, required: true }, // YYYY-MM-DD (Asia/Kolkata)
    dayStart: { type: Date, required: true },
    samples: { type: Number, default: 0 },
    up: { type: Number, default: 0 },
    down: { type: Number, default: 0 },
    incidentSec: { type: Number, default: 0 },
    latSum: { type: Number, default: 0 },
    latCount: { type: Number, default: 0 },
    buckets: Schema.Types.Mixed, // { "<bucketIndex>": count }
  }, { versionKey: false, minimize: false });
  rollupSchema.index({ serviceKey: 1, day: 1 }, { unique: true });
  rollupSchema.index({ dayStart: 1 }, { expireAfterSeconds: 365 * DAY });
  const DailyRollup = define('DailyRollup', rollupSchema);

  // Current debounced state of every service and every infra node (key "infra:<name>").
  const ServiceState = define('ServiceState', new Schema({
    key: { type: String, required: true, unique: true },
    kind: { type: String, default: 'service' }, // service | infra
    state: { type: String, default: 'unknown' },
    pending: String,
    pendingCount: { type: Number, default: 0 },
    lastChange: Date,
    latencyMs: Number,
    probes: Schema.Types.Mixed,
    detail: Schema.Types.Mixed,
  }, { timestamps: true, minimize: false }));

  const updateSchema = new Schema({
    message: String,
    status: String,
    author: { type: String, default: 'system' },
    ts: { type: Date, default: Date.now },
  }, { _id: true });
  const Incident = define('Incident', new Schema({
    serviceKeys: [String],
    title: { type: String, required: true },
    status: { type: String, enum: ['investigating', 'identified', 'monitoring', 'resolved'], default: 'investigating' },
    autoCreated: { type: Boolean, default: false },
    startedAt: { type: Date, default: Date.now },
    resolvedAt: Date,
    updates: [updateSchema],
  }, { timestamps: true }));

  const Maintenance = define('Maintenance', new Schema({
    services: [String], // empty = all services
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    note: String,
  }, { timestamps: true }));

  // Admin -> worker commands (check_now, test_alert). The two processes never call each other directly.
  const Command = define('Command', new Schema({
    type: { type: String, required: true },
    payload: Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
    claimedAt: Date,
    doneAt: Date,
    result: Schema.Types.Mixed,
  }, { versionKey: false }));
  Command.schema.index({ createdAt: 1 }, { expireAfterSeconds: DAY });

  // Free-form worker output: 'snapshot', 'containers', 'alerts'.
  const Meta = define('Meta', new Schema({
    key: { type: String, required: true, unique: true },
    value: Schema.Types.Mixed,
  }, { timestamps: true, minimize: false }));

  return { Service, Check, DailyRollup, ServiceState, Incident, Maintenance, Command, Meta };
}
