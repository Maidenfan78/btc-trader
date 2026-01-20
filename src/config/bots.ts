/**
 * Bot Configuration Loader
 *
 * Loads bot configuration from bots.json including enabled assets per bot.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Bot configuration from bots.json */
export interface BotConfig {
  id: string;
  name: string;
  stateFile: string;
  logFile: string;
  serviceName: string;
  csvDir: string;
  indicator: string;
  timeframe: string;
  enabledAssets: string[];
}

/** Cache for loaded bots */
let cachedBots: BotConfig[] | null = null;
let botsFilePath: string | null = null;

/**
 * Get the path to bots.json
 */
function getBotsFilePath(): string {
  if (botsFilePath) {
    return botsFilePath;
  }
  botsFilePath = path.join(process.cwd(), 'bots.json');
  return botsFilePath;
}

/**
 * Load all bot configurations
 */
export function getAllBotConfigs(): BotConfig[] {
  if (cachedBots) {
    return cachedBots;
  }

  const filePath = getBotsFilePath();

  if (!fs.existsSync(filePath)) {
    console.warn(`Warning: bots.json not found at ${filePath}`);
    return [];
  }

  const rawData = fs.readFileSync(filePath, 'utf-8');
  cachedBots = JSON.parse(rawData);
  return cachedBots!;
}

/**
 * Get bot configuration by ID
 */
export function getBotConfig(botId: string): BotConfig | undefined {
  const bots = getAllBotConfigs();
  return bots.find((bot) => bot.id === botId);
}

/**
 * Get enabled assets for a specific bot
 */
export function getBotEnabledAssets(botId: string): string[] {
  const bot = getBotConfig(botId);
  return bot?.enabledAssets ?? [];
}

/**
 * Update enabled assets for a bot and persist to file
 */
export function updateBotEnabledAssets(botId: string, enabledAssets: string[]): boolean {
  const bots = getAllBotConfigs();
  const botIndex = bots.findIndex((bot) => bot.id === botId);

  if (botIndex === -1) {
    return false;
  }

  bots[botIndex].enabledAssets = enabledAssets;

  // Persist to file
  const filePath = getBotsFilePath();
  fs.writeFileSync(filePath, JSON.stringify(bots, null, 2) + '\n', 'utf-8');

  // Clear cache to reload on next access
  cachedBots = null;

  return true;
}

/**
 * Clear the bot config cache
 */
export function clearBotConfigCache(): void {
  cachedBots = null;
}
