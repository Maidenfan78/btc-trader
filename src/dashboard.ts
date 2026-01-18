/**
 * Dashboard Entry Point
 *
 * Launches the trading dashboard API server using the platform's
 * dashboard factory with your custom configuration.
 */

import { createDashboardApp } from 'trading-bot-platform/dashboard';
import { loadEnvConfig } from 'trading-bot-platform';
import * as path from 'path';

// Load environment variables
loadEnvConfig('.env');

// Configuration from environment
const PORT = parseInt(process.env.DASHBOARD_PORT || '3001');
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

if (!ADMIN_PASSWORD_HASH) {
  console.warn('Warning: ADMIN_PASSWORD_HASH not set. Authentication will not work.');
  console.warn('Generate a hash with: npx bcrypt-cli hash <password>');
}

// File paths
const BASE_DIR = process.cwd();
const BOTS_FILE = path.join(BASE_DIR, 'bots.json');
const STATE_DIR = BASE_DIR;
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const CSV_DIR = path.join(BASE_DIR, 'logs', 'csv');

// CORS origins
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:5173', 'http://192.168.68.52:5173', 'http://192.168.68.20:5173'];

async function main() {
  console.log('Starting Dashboard API...');
  console.log(`Port: ${PORT}`);
  console.log(`Bots file: ${BOTS_FILE}`);
  console.log(`State dir: ${STATE_DIR}`);
  console.log(`Logs dir: ${LOGS_DIR}`);
  console.log(`CSV dir: ${CSV_DIR}`);
  console.log(`CORS origins: ${CORS_ORIGINS.join(', ')}`);

  try {
    const dashboard = createDashboardApp({
      port: PORT,
      botsFile: BOTS_FILE,
      stateDir: STATE_DIR,
      logsDir: LOGS_DIR,
      csvDir: CSV_DIR,
      jwtSecret: JWT_SECRET,
      adminUsername: process.env.ADMIN_USERNAME || 'admin',
      adminPasswordHash: ADMIN_PASSWORD_HASH,
      corsOrigins: CORS_ORIGINS,
      servicePrefix: 'bot@',
    });

    await dashboard.start();

    console.log(`Dashboard API running on port ${PORT}`);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await dashboard.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\nShutting down...');
      await dashboard.stop();
      process.exit(0);
    });

  } catch (error) {
    console.error('Failed to start dashboard:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { main };
