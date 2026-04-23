#!/usr/bin/env node
'use strict';

const path = require('path');
const logger = require('./util/logger');
const { loadConfig } = require('./config/ini-loader');
const { MqttClient } = require('./mqtt/client');
const { Heartbeat } = require('./bridge/heartbeat');
const { publishBridgeWarning } = require('./bridge/warnings');
const { NodeRegistry } = require('./bridge/node-registry');
const { BridgeCommandHandler } = require('./bridge/command-handler');
const { ZWaveDriver } = require('./radios/zwave/driver');
const { ZWaveEvents } = require('./radios/zwave/events');
const { ZWaveInclusion } = require('./radios/zwave/inclusion');
const { NodeCommandHandler } = require('./bridge/node-command-handler');
const { DiscoveredStore } = require('./discovery/discovered-store');
const { bridgeTopics } = require('./mqtt/contract');

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
    logger.configure({
        logDirectory: config.global.log_directory || null,
        logFilePrefix: 'pzb',
    });

    logger.info(`PZB starting — config: ${path.resolve(args.config)}`);
    logger.info(`Nodes configured: ${Object.keys(config.nodes).join(', ') || '(none)'}`);

    const startTime = Date.now();

    // --- MQTT client ---
    const mqtt = new MqttClient(config.mqtt);

    // --- Node registry (always constructed; tracks runtime node state) ---
    const nodeRegistry = new NodeRegistry(config.nodes);

    // --- Z-Wave driver (constructed eagerly; started after MQTT is up) ---
    let zwaveDriver = null;
    if (config.zwave && config.zwave.enabled) {
        zwaveDriver = new ZWaveDriver({
            port: config.zwave.port,
            cacheDir: config.zwave.cache_dir,
            keys: {
                s0: config.zwave.network_key_s0,
                s2_unauth: config.zwave.network_key_s2_unauth,
                s2_auth: config.zwave.network_key_s2_auth,
                s2_access: config.zwave.network_key_s2_access,
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

    // --- ZWaveEvents: wires driver → registry → MQTT (constructed after driver + registry) ---
    // eslint-disable-next-line no-unused-vars
    let zwaveEvents = null;
    let zwaveInclusion = null;
    if (zwaveDriver) {
        // Events object is constructed here; it attaches listeners to the driver.
        // A local reference is kept to prevent GC during the process lifetime.
        zwaveEvents = new ZWaveEvents({ zwaveDriver, nodeRegistry, mqttClient: mqtt });

        // Inclusion / Exclusion FSM
        zwaveInclusion = new ZWaveInclusion({
            zwaveDriver,
            defaultTimeoutMs: (config.zwave.include_timeout_s || 60) * 1000,
        });
        zwaveInclusion.on('warning', (w) => {
            publishBridgeWarning(mqtt, config.mqtt.base_topic, w);
        });
        zwaveInclusion.on('state-changed', () => {
            // Surface inclusion state via immediate heartbeat.
            if (heartbeat) heartbeat.flush();
        });
    }

    // --- Discovery store (captures new Z-Wave nodes seen during inclusion) ---
    const discoveredStore = new DiscoveredStore({
        filePath: config.global.discovered_ini_path || null,
        labelPrefix: config.global.default_discovered_label_prefix || 'discovered',
    });
    if (zwaveDriver) {
        zwaveDriver.on('zwave-node-added', (info) => {
            const controller = zwaveDriver.controller;
            const node = controller?.nodes?.get(info.nodeId);
            if (!node) return;
            const { descriptor, fragment } = discoveredStore.record(node);
            // Publish retained discovery notice per MQTT_API.md §6.
            const topic = bridgeTopics(config.mqtt.base_topic).discovered('zwave', info.nodeId);
            mqtt.publish(topic, {
                timestamp: new Date().toISOString(),
                radio: 'zwave',
                node_id: info.nodeId,
                descriptor,
                fragment,
            }, { retain: true });
            logger.info(`Discovered node zwave-${info.nodeId} published to ${topic}`);
        });
        zwaveDriver.on('zwave-node-removed', ({ nodeId }) => {
            discoveredStore.forget(nodeId);
            const topic = bridgeTopics(config.mqtt.base_topic).discovered('zwave', nodeId);
            // Clear retained discovery notice.
            mqtt.publish(topic, '', { retain: true });
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
            if (s === 'starting') overall = 'starting';
            else if (s === 'degraded') overall = 'degraded';
            else if (s === 'error') overall = 'degraded';
            else if (s === 'stopped') overall = 'starting';
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
            nodes: nodeRegistry.getSummary(),
            inclusion: zwaveInclusion
                ? zwaveInclusion.getStatus()
                : { active: false, radio: null, mode: null, started_at: null, timeout_ms: null },
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

    // --- Bridge command handler (must come after heartbeat so buildStatus is ready) ---
    // eslint-disable-next-line no-unused-vars
    const commandHandler = new BridgeCommandHandler({
        mqttClient: mqtt,
        baseTopic: config.mqtt.base_topic,
        getStatus: buildStatus,
        publishWarning: (w) => publishBridgeWarning(mqtt, config.mqtt.base_topic, w),
        zwaveInclusion,
        zwaveDriver,
        nodeRegistry,
    });

    // --- Per-node command handler (setRelay / pulseRelay for relay/switch nodes) ---
    // eslint-disable-next-line no-unused-vars
    const nodeCommandHandler = new NodeCommandHandler({
        mqttClient: mqtt,
        nodeRegistry,
        zwaveDriver,
        zwaveEvents,
    });

    // --- Z-Wave startup (non-fatal: failures schedule reconnect) ---
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
        logger.close();
        process.exit(0);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    logger.info('PZB ready');
}

main();
