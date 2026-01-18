/**
 * Bot Runner
 *
 * Central launcher for all bots. Reads bot config from bots.json,
 * resolves the appropriate entry point, and spawns the bot as a child process.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { loadEnvConfig } from 'trading-bot-platform';

interface BotConfig {
  id: string;
  indicator?: string;
  timeframe?: string;
}

function getBotId(): string | null {
  const argIndex = process.argv.findIndex((arg) => arg === '--bot-id');
  if (argIndex >= 0 && process.argv[argIndex + 1]) {
    return process.argv[argIndex + 1];
  }
  return process.env.BOT_ID || null;
}

function resolveBotsFile(): string {
  return path.join(__dirname, '../bots.json');
}

function loadBots(): BotConfig[] {
  const filePath = resolveBotsFile();
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function normalizeIndicator(value?: string): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeTimeframe(value?: string): string {
  const raw = (value || '').toLowerCase();
  if (raw === 'd1') return '1d';
  return raw;
}

function resolveEntry(indicator: string, timeframe: string): string {
  // MFI bots have timeframe-specific entries
  if (indicator === 'mfi') {
    if (timeframe === '1h') return './bots/mfi-1h';
    if (timeframe === '1d') return './bots/mfi-daily';
    if (timeframe === '4h') return './bots/mfi-4h';
  }

  // Other indicator bots
  if (indicator === 'tcf2') return './bots/tcf2';
  if (indicator === 'kpss') return './bots/kpss';
  if (indicator === 'tdfi') return './bots/tdfi';
  if (indicator === 'dssmom') return './bots/dssmom';

  throw new Error(`Unsupported indicator/timeframe: ${indicator} ${timeframe}`);
}

function ensureEnvDefaults(botId: string): void {
  if (!process.env.BOT_ID) {
    process.env.BOT_ID = botId;
  }
  if (!process.env.BOT_ENV_FILE) {
    process.env.BOT_ENV_FILE = path.join(process.cwd(), `.env.${botId}`);
  }
  if (!process.env.BOT_CSV_DIR) {
    process.env.BOT_CSV_DIR = path.join(process.cwd(), 'logs', 'csv', botId);
  }
  if (!process.env.BOT_STATE_FILE) {
    process.env.BOT_STATE_FILE = path.join(process.cwd(), `state-${botId}.json`);
  }
  if (!process.env.BOT_LOG_FILE) {
    process.env.BOT_LOG_FILE = path.join(process.cwd(), 'logs', `bot-${botId}.log`);
  }
  if (!process.env.BOT_ERROR_LOG_FILE) {
    process.env.BOT_ERROR_LOG_FILE = path.join(process.cwd(), 'logs', `error-${botId}.log`);
  }
}

function main(): void {
  const botId = getBotId();
  if (!botId) {
    throw new Error('Missing bot id. Use --bot-id <id> or set BOT_ID.');
  }

  ensureEnvDefaults(botId);

  // Load global env first
  loadEnvConfig('.env');

  const bots = loadBots();
  const bot = bots.find((b) => b.id === botId);
  if (!bot) {
    throw new Error(`Bot not found: ${botId}`);
  }

  const indicator = normalizeIndicator(bot.indicator);
  const timeframe = normalizeTimeframe(bot.timeframe);
  const entry = resolveEntry(indicator, timeframe);
  const modulePath = path.join(__dirname, entry);

  console.log(`Starting bot: ${botId} (${indicator}/${timeframe})`);
  console.log(`Entry: ${modulePath}`);

  const child = spawn(process.execPath, [modulePath], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
  });

  const keepAlive = setInterval(() => {
    // Keep the parent process alive while the child runs.
  }, 1000);

  if (child.stdout) {
    child.stdout.pipe(process.stdout);
  }
  if (child.stderr) {
    child.stderr.pipe(process.stderr);
  }

  child.on('exit', (code) => {
    clearInterval(keepAlive);
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    console.error('Failed to start bot process:', error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    child.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
  });
}

main();
