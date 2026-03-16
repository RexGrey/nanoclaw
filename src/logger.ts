import pino from 'pino';
import fs from 'fs';
import path from 'path';

const isCli = !!(process.env.NANOCLAW_CLI && process.stdin.isTTY);

let logDestination: pino.DestinationStream | undefined;
if (isCli) {
  const logDir = path.resolve('store');
  fs.mkdirSync(logDir, { recursive: true });
  logDestination = pino.destination(path.join(logDir, 'nanoclaw.log'));
}

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    ...(!isCli && {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    }),
  },
  ...(logDestination ? [logDestination] : []),
);

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
