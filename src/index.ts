/**
 * btc-trader Main Entry Point
 *
 * Personal trading bot application using the trading-bot-platform.
 * Run bots via bot-runner or dashboard.
 */

export { main as runDashboard } from './dashboard';
export { main as runMFIDaily, runBotCycle as runMFIDailyCycle } from './bots/mfi-daily';
export { runBotCycle4H } from './bots/mfi-4h';
export { runBotCycleTCF2 } from './bots/tcf2';
export { runBotCycleKPSS } from './bots/kpss';
export { runBotCycleTDFI } from './bots/tdfi';
export { runBotCycleDSSMOM } from './bots/dssmom';

// Re-export config loaders
export * from './config';

// Re-export continuous mode handlers
export * from './continuous';

console.log('btc-trader - Personal Trading Bot');
console.log('');
console.log('Usage:');
console.log('  npm run start:bot -- --bot-id <bot-id>  Run a specific bot');
console.log('  npm run start:dashboard                  Start the dashboard');
console.log('');
console.log('Available bots are defined in bots.json');
