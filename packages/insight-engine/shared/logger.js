'use strict';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';
const MIN_LEVEL = process.env.LOG_LEVEL || 'info';

function log(level, category, message, data) {
  if (LEVELS[level] < LEVELS[MIN_LEVEL]) return;
  const ts = new Date().toISOString().split('T')[1].slice(0, 8);
  const lvl = level.toUpperCase().padEnd(5);
  const cat = `[${category}]`.padEnd(24);
  let line = `${COLORS[level]}${ts} ${lvl}${RESET} ${cat} ${message}`;
  if (data) line += ` ${JSON.stringify(data)}`;
  console.log(line);
}

const logger = {
  debug: (cat, msg, data) => log('debug', cat, msg, data),
  info:  (cat, msg, data) => log('info',  cat, msg, data),
  warn:  (cat, msg, data) => log('warn',  cat, msg, data),
  error: (cat, msg, data) => log('error', cat, msg, data),
};

module.exports = logger;
