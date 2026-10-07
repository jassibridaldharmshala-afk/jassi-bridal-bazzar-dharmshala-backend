const dotenv = require('dotenv');
const path = require('path');
const { Worker } = require('bullmq');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config();

const connectDB = require('../config/db');
const { getReelImportConfig, isReelImportEnabled } = require('../config/reelImport');
const { QUEUE_NAME, getRedisConnection } = require('../queues/reelImport.queue');
const { processQueuedReelImport } = require('./reelImport.processor');

async function start() {
  if (!isReelImportEnabled()) throw new Error('Reel import worker is disabled.');
  const connection = getRedisConnection();
  if (!connection) throw new Error('REDIS_URL is required for the production reel worker.');
  await connectDB();
  const worker = new Worker(QUEUE_NAME, processQueuedReelImport, {
    connection,
    concurrency: getReelImportConfig().workerConcurrency,
  });
  worker.on('failed', (job, error) => {
    console.error(JSON.stringify({
      event: 'reel_queue_job_failed',
      jobId: job?.data?.jobId,
      code: error.code || 'REEL_PROCESSING_FAILED',
    }));
  });
  const shutdown = async () => {
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  console.log(JSON.stringify({ event: 'reel_worker_started', concurrency: getReelImportConfig().workerConcurrency }));
}

start().catch((error) => {
  console.error(JSON.stringify({ event: 'reel_worker_start_failed', message: error.message }));
  process.exit(1);
});
