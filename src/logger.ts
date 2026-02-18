import pino, { type LoggerOptions } from 'pino';

import { config } from './config.js';

const opts: LoggerOptions = { level: config.logLevel };
if (process.env.NODE_ENV !== 'production') {
  (opts as any).transport = {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard' },
  };
}

export const logger = pino(opts);
