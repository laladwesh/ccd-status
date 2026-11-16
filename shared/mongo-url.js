// Builds the status database URL from parts, so passwords with special characters are encoded
// correctly. MONGO_URL (a full URL) wins if set. Credentials are optional: the host mongod may or
// may not have auth enabled; when MONGO_USER is set the user is authenticated against MONGO_AUTH_SOURCE.
export function buildMongoUrl(env = process.env) {
  if (env.MONGO_URL) return env.MONGO_URL;
  const host = env.MONGO_HOST || '127.0.0.1';
  const port = env.MONGO_PORT || '27017';
  const db = env.MONGO_DB || 'ccdstatus';
  const enc = encodeURIComponent;
  const auth = env.MONGO_USER ? `${enc(env.MONGO_USER)}:${enc(env.MONGO_PASSWORD || '')}@` : '';
  const query = env.MONGO_USER ? `?authSource=${enc(env.MONGO_AUTH_SOURCE || db)}` : '';
  return `mongodb://${auth}${host}:${port}/${db}${query}`;
}
