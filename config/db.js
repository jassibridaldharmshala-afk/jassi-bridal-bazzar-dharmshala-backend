const dns = require('node:dns');
const mongoose = require('mongoose');

function usePublicDnsForAtlasSrv(uri = '') {
  if (!String(uri).trim().startsWith('mongodb+srv://')) return;
  const configured = String(process.env.MONGO_DNS_SERVERS || '').trim();
  if (configured.toLowerCase() === 'system') return;
  const servers = (configured || '8.8.8.8,1.1.1.1').split(',').map((server) => server.trim()).filter(Boolean);
  try {
    // Validate before changing either resolver so invalid configuration changes neither.
    new dns.Resolver().setServers(servers);
    dns.setServers(servers);
    // The MongoDB driver uses dns.promises. On Windows/Node 24, changing the
    // callback resolver alone can leave the promise resolver on the OS DNS.
    dns.promises.setServers(servers);
  } catch {
    console.warn('MongoDB DNS configuration could not be applied. Check MONGO_DNS_SERVERS.');
  }
}

async function connectDB() {
  try {
    mongoose.set('bufferCommands', false);
    if (!process.env.MONGO_URI) {
      console.warn('MONGO_URI missing. API started without database connection.');
      return;
    }
    usePublicDnsForAtlasSrv(process.env.MONGO_URI);
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 7000 });
    console.log('MongoDB connected');
  } catch (error) {
    console.error(`MongoDB connection failed: ${error.message}`);
    if (process.env.REQUIRE_DATABASE === 'true') {
      process.exit(1);
    }
    console.warn('API is still running without a database connection. Database-backed routes will return errors until MongoDB is reachable.');
  }
}

module.exports = connectDB;
module.exports.usePublicDnsForAtlasSrv = usePublicDnsForAtlasSrv;
