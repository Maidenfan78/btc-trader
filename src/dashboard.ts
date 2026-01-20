/**
 * Dashboard Entry Point
 *
 * Launches the trading dashboard API server using the platform's
 * dashboard factory with your custom configuration, plus custom
 * asset management routes.
 */

import { createDashboardApp } from 'trading-bot-platform/dashboard';
import { loadEnvConfig } from 'trading-bot-platform';
import * as path from 'path';
import { getAllAssets } from './config/assets.js';
import {
  getAllBotConfigs,
  getBotConfig,
  updateBotEnabledAssets,
  clearBotConfigCache,
} from './config/bots.js';

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
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim())
  : ['http://localhost:5173', 'http://192.168.68.52:5173', 'http://192.168.68.20:5173'];

/**
 * Register custom asset management routes on the provided app instance.
 */
function registerAssetRoutes(app: any) {

  /**
   * GET /api/assets - List all available assets
   */
  app.get('/api/assets', (_req: any, res: any) => {
    try {
      const assets = getAllAssets();
      res.json({
        assets: assets.map((a) => ({
          symbol: a.symbol,
          name: a.name,
          binanceSymbol: a.binanceSymbol,
          tradeLegUsdc: a.tradeLegUsdc,
          hasMint: !!a.solanaMint,
        })),
      });
    } catch (error) {
      console.error('Error fetching assets:', error);
      res.status(500).json({ error: 'Failed to fetch assets' });
    }
  });

  /**
   * GET /api/assets/summary - Get asset configuration summary for all bots
   */
  app.get('/api/assets/summary', (_req: any, res: any) => {
    try {
      const assets = getAllAssets();
      const bots = getAllBotConfigs();

      const summary = {
        totalAssets: assets.length,
        assets: assets.map((a) => a.symbol),
        bots: bots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          enabledAssets: bot.enabledAssets,
          enabledCount: bot.enabledAssets.length,
        })),
      };

      res.json(summary);
    } catch (error) {
      console.error('Error fetching assets summary:', error);
      res.status(500).json({ error: 'Failed to fetch assets summary' });
    }
  });

  /**
   * GET /api/bots/:botId/assets - Get enabled assets for a bot
   */
  app.get('/api/bots/:botId/assets', (req: any, res: any) => {
    try {
      const { botId } = req.params;
      const bot = getBotConfig(botId);

      if (!bot) {
        res.status(404).json({ error: `Bot not found: ${botId}` });
        return;
      }

      res.json({
        botId: bot.id,
        botName: bot.name,
        enabledAssets: bot.enabledAssets,
      });
    } catch (error) {
      console.error('Error fetching bot assets:', error);
      res.status(500).json({ error: 'Failed to fetch bot assets' });
    }
  });

  /**
   * PUT /api/bots/:botId/assets - Update enabled assets for a bot
   * Requires authentication
   */
  app.put('/api/bots/:botId/assets', (req: any, res: any) => {
    try {
      // Check for auth token (simple check - platform handles JWT validation)
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { botId } = req.params;
      const { enabledAssets } = req.body;

      if (!Array.isArray(enabledAssets)) {
        res.status(400).json({ error: 'enabledAssets must be an array' });
        return;
      }

      // Validate that all requested assets exist
      const allAssets = getAllAssets();
      const validSymbols = new Set(allAssets.map((a) => a.symbol.toUpperCase()));
      const invalidAssets = enabledAssets.filter(
        (s: string) => !validSymbols.has(s.toUpperCase())
      );

      if (invalidAssets.length > 0) {
        res.status(400).json({
          error: `Unknown assets: ${invalidAssets.join(', ')}`,
        });
        return;
      }

      const success = updateBotEnabledAssets(botId, enabledAssets);

      if (!success) {
        res.status(404).json({ error: `Bot not found: ${botId}` });
        return;
      }

      // Clear cache to ensure fresh data
      clearBotConfigCache();

      res.json({
        success: true,
        botId,
        enabledAssets,
        message: 'Assets updated. Restart bot to apply changes.',
      });
    } catch (error) {
      console.error('Error updating bot assets:', error);
      res.status(500).json({ error: 'Failed to update bot assets' });
    }
  });

  return;
}

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

    // Insert custom routes BEFORE the 404 handler
    // We need to manipulate the router stack to insert our routes before the notFoundHandler
    const stack = dashboard.app._router.stack;
    const notFoundIndex = stack.findIndex(
      (layer: any) => layer.name === 'notFoundHandler'
    );
    const stackLengthBefore = stack.length;

    registerAssetRoutes(dashboard.app);

    if (notFoundIndex !== -1) {
      // Move newly added route layers before the 404 handler
      const newLayers = stack.splice(stackLengthBefore);
      stack.splice(notFoundIndex, 0, ...newLayers);
      console.log('Custom routes inserted before 404 handler');
    } else {
      console.log('Custom routes added (404 handler not found)');
    }

    await dashboard.start();

    console.log(`Dashboard API running on port ${PORT}`);
    console.log(`Custom routes: GET /api/assets, GET/PUT /api/bots/:botId/assets`);

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
