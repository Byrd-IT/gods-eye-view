#!/usr/bin/env node
/**
 * Prints which history mode each feed gets under the current environment, and
 * which feeds could use live-api. Reads settings only; touches no network, no
 * database and no file.
 *
 *   npm run history:support
 *   node scripts/history-support.mjs --json
 *
 * Exits 1 when the HISTORY_* settings are invalid (the same check the server
 * makes at boot), so it can sit in a deploy check.
 */
import { loadHistoryConfig, HistoryConfigError } from '../server/history/config.js';
import { LIVE_API_SUPPORT, describeSupport, liveApiRefusal } from '../server/history/live/support.js';

const json = process.argv.includes('--json');
let config;
try {
  config = loadHistoryConfig(process.env);
} catch (error) {
  if (!(error instanceof HistoryConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}
const rows = describeSupport(config);
if (json) {
  console.log(JSON.stringify({ rows, warnings: config.warnings, liveApi: LIVE_API_SUPPORT }, null, 2));
} else {
  const pad = (text, width) => String(text).padEnd(width);
  console.log(`${pad('feed', 11)}${pad('mode', 10)}${pad('slider', 11)}${pad('live-api', 10)}note`);
  for (const row of rows)
    console.log(`${pad(row.feed, 11)}${pad(row.mode, 10)}${pad(row.slider === 'hidden' ? 'hidden' : 'available', 11)}${pad(row.liveApiOffer ? 'offered' : 'none', 10)}${row.liveApiOffer ? row.note : liveApiRefusal(row.feed) || row.note}`);
  for (const warning of config.warnings) console.log(`warning: ${warning}`);
}
