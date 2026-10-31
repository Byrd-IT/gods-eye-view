import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { createSqliteStore } from './sqlite.js';
import { defineHistoryStoreContract } from './contract.mjs';

defineHistoryStoreContract('sqlite (in memory)', () => createSqliteStore({ path: ':memory:' }));

const directory = mkdtempSync(path.join(tmpdir(), 'gev-history-contract-'));
after(() => rmSync(directory, { recursive: true, force: true }));
let counter = 0;
defineHistoryStoreContract('sqlite (file, WAL)', () => createSqliteStore({ path: path.join(directory, `c${counter++}.sqlite`) }));
