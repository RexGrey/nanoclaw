#!/usr/bin/env tsx

import { runCliClient } from './cli-terminal.js';

runCliClient().catch((err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
