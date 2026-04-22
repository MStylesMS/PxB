#!/usr/bin/env node
'use strict';

const path = require('path');
const logger = require('./util/logger');
const { loadConfig } = require('./config/ini-loader');
const { MqttClient } = require('./mqtt/client');
const { Heartbeat } = require('./bridge/heartbeat');
const { publishBridgeWarning } = require('./bridge/warnings');
const { ZWaveDriver } = require('./radios/zwave/driver');

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

    // --- Z-Wave driver (constructed eagerly; started after MQTT is up) ---
    let zwaveDriver = null;
    if (config.zwave && config.zwave.enabled) {
        zwaveDriver = new ZWaveDriver({
            port: config.zwave.port,
            cacheDir: config.zwave.cache_dir,
            keys: {
                s0:         config.zwave.network_key_s0,
                s2_unauth:  config.zwave.network_key_s2_unauth,
                s2_auth:    config.zwave.network_key_s2_auth,
                s2_access:  config.zwave.network_key_s2_access,
            },
        });

        zwaveDriver.on('warning', (w) => {
            // Only publish if MQTT is connected; fall back to log-only otherwise.
            publishBridgeWarning(mqtt, config.mqtt.base_topic, w);
        });

        zwaveDriver.on('state-changed', () => {
            // Push an immediate heartbeat so Web UIs see transitions without waiting.
            if (heartbeat) heartbeat.flush();
        });
    }

    // Build status generator for heartbeat
    function buildStatus(overrides = {}) {
        const zwaveStatus = zwaveDriver
            ? { ...zwaveDriver.getStatus() }
            : (config.zwave ? { enabled: false } : { enabled: false });

        // Derive overall bridge state from radio state(s)
        let overall = 'ok';
        if (zwaveDriver) {
            const s = zwaveDriver.state;
            if (s === 'starting')       overall = 'starting';
            else if (s === 'degraded')  overall = 'degraded';
            else if (s === 'error')     overall = 'degraded';
            else if (s === 'stopped')   overall = 'starting';
        }

        return {
            timestamp: new Date().toISOString(),
            pid: process.pid,
            uptime_s: Math.floor((Date.now() - startTime) / 1000),
            state: overall,
            version: require('../package.json').version,
            host: require('os').hostname(),
            radios: {
                zwave: zwaveStatus,
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

    // --- Heartbeat (declared here so the state-changed handler can see it) ---
    let heartbeat = new Heartbeat(
        mqtt,
        config.mqtt.base_topic,
        config.global.heartbeat_interval,
        buildStatus
    );
    heartbeat.start();

    // --- Start Z-Wave driver (non-fatal: failures schedule reconnect) ---
    if (zwaveDriver) {
        try {
            await zwaveDriver.start();
        } catch (err) {
            logger.error(`Z-Wave initial start failed (will retry): ${err.message}`);
            // Driver has already scheduled a reconnect and published a warning.
        }
    }

    // --- Graceful shutdown ---
    async function shutdown(signal) {
        logger.info(`Received ${signal} — shutting down`);
        if (zwaveDriver) {
            try { await zwaveDriver.stop(); } catch (err) { logger.warn(`Z-Wave stop error: ${err.message}`); }
        }
        heartbeat.flush({ state: 'stopping' });
        heartbeat.stop();
        await mqtt.disconnect();
        logger.info('PZB stopped');
        process.exit(0);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    logger.info('PZB ready');
}

main();
