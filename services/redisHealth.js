const { getRedisConnection } = require('../queues/reelImport.queue');

const PING_MS = 800;

async function redisHealthStatus() {
  if (!String(process.env.REDIS_URL || '').trim()) return 'skipped';

  let client;
  try {
    const connection = getRedisConnection();
    if (!connection) return 'skipped';

    const Redis = require('ioredis');
    client = new Redis({
      ...connection,
      maxRetriesPerRequest: 1,
      connectTimeout: PING_MS,
      commandTimeout: PING_MS,
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });

    await Promise.race([
      client.connect().then(() => client.ping()),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), PING_MS);
      }),
    ]);
    return 'connected';
  } catch {
    return 'disconnected';
  } finally {
    if (client) {
      try {
        client.disconnect();
      } catch {
        // ignore
      }
    }
  }
}

module.exports = { redisHealthStatus };
