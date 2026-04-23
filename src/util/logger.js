'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

let currentLevel = 2; // info
let logStream = null;

function setLevel(name) {
    const n = LEVELS[name?.toLowerCase()];
    if (n === undefined) throw new Error(`Unknown log level: ${name}`);
    currentLevel = n;
}

function configure(opts = {}) {
    const { logDirectory = null, logFilePrefix = 'pzb' } = opts;
    if (!logDirectory) return;

    fs.mkdirSync(logDirectory, { recursive: true });
    const safeTs = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
    const logPath = path.join(logDirectory, `${logFilePrefix}-${safeTs}.log`);
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    log('info', `File logging enabled: ${logPath}`);
}

function log(level, ...args) {
    if (LEVELS[level] > currentLevel) return;
    const ts = new Date().toISOString();
    const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${args.join(' ')}`;
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(`${line}\n`);
    if (logStream) {
        logStream.write(`${line}\n`);
    }
}

function close() {
    if (logStream) {
        logStream.end();
        logStream = null;
    }
}

module.exports = {
    configure,
    setLevel,
    close,
    error: (...a) => log('error', ...a),
    warn: (...a) => log('warn', ...a),
    info: (...a) => log('info', ...a),
    debug: (...a) => log('debug', ...a),
    trace: (...a) => log('trace', ...a),
};
