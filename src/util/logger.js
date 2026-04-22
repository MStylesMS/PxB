'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

let currentLevel = 2; // info

function setLevel(name) {
    const n = LEVELS[name?.toLowerCase()];
    if (n === undefined) throw new Error(`Unknown log level: ${name}`);
    currentLevel = n;
}

function log(level, ...args) {
    if (LEVELS[level] > currentLevel) return;
    const ts = new Date().toISOString();
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(`${ts} [${level.toUpperCase().padEnd(5)}] ${args.join(' ')}\n`);
}

module.exports = {
    setLevel,
    error: (...a) => log('error', ...a),
    warn: (...a) => log('warn', ...a),
    info: (...a) => log('info', ...a),
    debug: (...a) => log('debug', ...a),
    trace: (...a) => log('trace', ...a),
};
