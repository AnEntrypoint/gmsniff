#!/usr/bin/env node
import { createServer } from './server.js';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

const logDir = process.env.GM_LOG_DIR || path.join(os.homedir(), '.claude', 'gm-log');
const port = parseInt(process.env.PORT || '0', 10);

const { url } = await createServer({ logDir, port });
process.stderr.write(`gmsniff listening at ${url}\n`);

try {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  execSync(cmd, { shell: true });
} catch {}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
