#!/usr/bin/env node
'use strict';

const path = require('path');
const logger = require('./util/logger');
const { loadConfig } = require('./config/ini-loader');
const { MqttClient } = require('./mqtt/client');
const { Heartbeat } = require('./bridge/heartbeat');

// --- Argument parsing (minimal, no deps) ---
function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--config' && argv[i + 1]) {
            args.config = argv[++i];
        } else if (argv[i] === '--log-level' && argv[i + 1]) {
            args.logLevel = argv[++i];
        }
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);

    if (!args.config) {
        process.stderr.write('Usage: pzb --config <path/to/pzb.ini>\n');
        process.exit(1);
    }

    // Load + validate config (fail fast on bad config)
    let config;
    try {
        config = loadConfig(args.config);
    } catch (err) {
        process.stderr.write(`${err.message}\n`);
        process.exit(1);
    }

    // Apply log level (args override config)
    const logLevel = args.logLevel || config.global.log_level || 'info';
    logger.setLevel(logLevel);

    logger.info(`PZB starting — config: ${path.resolve(args.config)}`);
    logger.info(`Nodes configured: ${Object.keys(config.nodes).join(', ') || '(none)'}`);

    const startTime = Date.now();

    // --- MQTT client ---
    const mqtt = new MqttClient(config.mqtt);

    // Build status generator for heartbeat
    function buildStatus(overrides = {}) {
        return {
            timestamp: new Date().toISOString(),
            pid: process.pid,
            uptime_s: Math.floor((Date.now() - startTime) / 1000),
            state: 'ok',
            version: require('../package.json').version,
            host: require('os').hostname(),
            radios: {
                zwave: config.zwave ? { enabled: config.zwave.enabled, connected: false, port: config.zwave.port, node_count: 0, last_error: null } : { enabled: false },
                zigbee: config.zigbee ? { enabled: config.zigbee.enabled, connected: false } : { enabled: false },
            },
            nodes: { total: Object.keys(config.nodes).length, ready: 0, failed: 0, interviewing: 0 },
            inclusion: { active: false, radio: null, started_at: null },
            ...overrides,
        };
    }

    // --- Connect MQTT ---
    try {
        await mqtt.connect();
    } catch (err) {
        logger.error(`MQTT connection failed: ${err.message}`);
        process.exit(1);
    }

    // --- Heartbeat ---
    const heartbeat = new Heartbeat(
        mqtt,
        config.mqtt.base_topic,
        config.global.heartbeat_interval,
        buildStatus
    );
    heartbeat.start();

    // --- Graceful shutdown ---
    async function shutdown(signal) {
        logger.info(`Received ${signal} — shutting down`);
        heartbeat.flush({ state: 'stopping' });
        heartbeat.stop();
        await mqtt.disconnect();
        logger.info('PZB stopped');
        process.exit(0);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    logger.info('PZB ready — radio drivers not yet attached (Phase 1.2+)');
}

main();
