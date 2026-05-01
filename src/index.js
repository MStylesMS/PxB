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
const { ZigbeeDriver } = require('./radios/zigbee/driver');
const { ZigbeeEvents } = require('./radios/zigbee/events');
const { ZigbeeInclusion } = require('./radios/zigbee/inclusion');
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
        logFilePrefix: 'pxb',
    });

    logger.info(`PxB starting — config: ${path.resolve(args.config)}`);
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

    // --- Zigbee driver (constructed eagerly; started after MQTT is up) ---
    let zigbeeDriver = null;
    let zigbeeEvents = null;
    let zigbeeInclusion = null;
    if (config.zigbee && config.zigbee.enabled) {
        // Build network opts only when the caller has configured something;
        // herdsman auto-generates pan_id, extended_pan_id, channel, and
        // network_key when the network object is absent.
        const zNet = {};
        if (config.zigbee.pan_id !== undefined)          zNet.panId = config.zigbee.pan_id;
        if (config.zigbee.extended_pan_id !== undefined) zNet.extendedPanId = config.zigbee.extended_pan_id;
        if (config.zigbee.channel !== undefined)         zNet.channel = config.zigbee.channel;
        if (config.zigbee.network_key !== undefined)     zNet.networkKey = config.zigbee.network_key;

        zigbeeDriver = new ZigbeeDriver({
            port: config.zigbee.port,
            baudRate: config.zigbee.baud_rate,
            databasePath: config.zigbee.db_path,
            network: Object.keys(zNet).length ? zNet : null,
        });

        zigbeeDriver.on('warning', (w) => {
            publishBridgeWarning(mqtt, config.mqtt.base_topic, w);
        });
        zigbeeDriver.on('state-changed', () => {
            if (heartbeat) heartbeat.flush();
        });

        zigbeeEvents = new ZigbeeEvents({ zigbeeDriver, nodeRegistry, mqttClient: mqtt });

        zigbeeInclusion = new ZigbeeInclusion({
            zigbeeDriver,
            defaultTimeoutMs: (config.zigbee.include_timeout_s || 60) * 1000,
        });
        zigbeeInclusion.on('warning', (w) => {
            publishBridgeWarning(mqtt, config.mqtt.base_topic, w);
        });
        zigbeeInclusion.on('state-changed', () => {
            if (heartbeat) heartbeat.flush();
        });

        zigbeeDriver.on('zigbee-device-joined', ({ ieee }) => {
            const device = zigbeeDriver.getDeviceByIeee(ieee);
            if (!device) return;
            const { descriptor, fragment } = discoveredStore.recordZigbee(device);
            const tail = descriptor.ieee ? descriptor.ieee.slice(-4) : 'xxxx';
            const topic = bridgeTopics(config.mqtt.base_topic).discovered('zigbee', tail);
            mqtt.publish(topic, {
                timestamp: new Date().toISOString(),
                radio: 'zigbee',
                ieee,
                descriptor,
                fragment,
            }, { retain: true });
            logger.info(`Discovered node zigbee-${tail} published to ${topic}`);
        });
        zigbeeDriver.on('zigbee-device-left', ({ ieee }) => {
            const normalized = (ieee || '').toString().toLowerCase();
            const tail = normalized.slice(-4) || 'xxxx';
            discoveredStore.forgetZigbee(ieee);
            const topic = bridgeTopics(config.mqtt.base_topic).discovered('zigbee', tail);
            mqtt.publish(topic, '', { retain: true });
        });
    }

    // Build status generator for heartbeat
    function buildStatus(overrides = {}) {
        const zwaveStatus = zwaveDriver
            ? { ...zwaveDriver.getStatus() }
            : (config.zwave ? { enabled: false } : { enabled: false });

        const zigbeeStatus = zigbeeDriver
            ? { ...zigbeeDriver.getStatus() }
            : (config.zigbee ? { enabled: config.zigbee.enabled, connected: false } : { enabled: false });

        // Derive overall bridge state from the combined radio state(s).
        let overall = 'ok';
        const radioStates = [];
        if (zwaveDriver) radioStates.push(zwaveDriver.state);
        if (zigbeeDriver) radioStates.push(zigbeeDriver.state);
        if (radioStates.some((s) => s === 'starting' || s === 'stopped')) overall = 'starting';
        if (radioStates.some((s) => s === 'degraded' || s === 'error')) overall = 'degraded';

        // Combine inclusion status (only one can be active at a time in practice).
        let inclusion = { active: false, radio: null, mode: null, started_at: null, timeout_ms: null };
        if (zwaveInclusion && zwaveInclusion.getStatus().active) inclusion = zwaveInclusion.getStatus();
        else if (zigbeeInclusion && zigbeeInclusion.getStatus().active) inclusion = zigbeeInclusion.getStatus();

        return {
            timestamp: new Date().toISOString(),
            pid: process.pid,
            uptime_s: Math.floor((Date.now() - startTime) / 1000),
            state: overall,
            version: require('../package.json').version,
            host: require('os').hostname(),
            radios: {
                zwave: zwaveStatus,
                zigbee: zigbeeStatus,
            },
            nodes: nodeRegistry.getSummary(),
            inclusion,
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
        zigbeeInclusion,
        zigbeeDriver,
        nodeRegistry,
    });

    // --- Per-node command handler (setRelay / pulseRelay for relay/switch nodes) ---
    // eslint-disable-next-line no-unused-vars
    const nodeCommandHandler = new NodeCommandHandler({
        mqttClient: mqtt,
        nodeRegistry,
        zwaveDriver,
        zwaveEvents,
        zigbeeDriver,
        zigbeeEvents,
    });

    // --- Domain adapters (lights, switches, inputs, outputs) ---
    // Scaffold: initialize empty adapter maps; R3-R4 agents will populate these.
    const domainAdapters = {
        lights: new Map(),      // Backend → adapter instances (e.g., 'hue' → [HueAdapter, ...])
        switches: new Map(),    // Backend → adapter instances (e.g., 'shelly' → [ShellyAdapter, ...])
        inputs: new Map(),      // Input aggregator zone → InputsAdapter
        outputs: new Map(),     // Output aggregator zone → OutputsAdapter
    };

    // Placeholder: load configured domain adapters once backends are implemented.
    // For now, log which zones are configured but not yet instantiated.
    try {
        const lightsZones = Object.keys(config).filter((k) => k.startsWith('lights:'));
        const switchesZones = Object.keys(config).filter((k) => k.startsWith('switches:'));
        const inputsZones = Object.keys(config).filter((k) => k.startsWith('inputs:'));
        const outputsZones = Object.keys(config).filter((k) => k.startsWith('outputs:'));

        if (lightsZones.length > 0) logger.info(`Lights zones configured: ${lightsZones.join(', ')} (adapters not yet implemented)`);
        if (switchesZones.length > 0) logger.info(`Switches zones configured: ${switchesZones.join(', ')} (adapters not yet implemented)`);
        if (inputsZones.length > 0) logger.info(`Inputs zones configured: ${inputsZones.join(', ')} (aggregator not yet implemented)`);
        if (outputsZones.length > 0) logger.info(`Outputs zones configured: ${outputsZones.join(', ')} (aggregator not yet implemented)`);
    } catch (err) {
        logger.warn(`Failed to enumerate domain adapters: ${err.message}`);
    }

    // --- Z-Wave startup (non-fatal: failures schedule reconnect) ---
    if (zwaveDriver) {
        try {
            await zwaveDriver.start();
        } catch (err) {
            logger.error(`Z-Wave initial start failed (will retry): ${err.message}`);
        }
    }

    // --- Zigbee startup (non-fatal: failures schedule reconnect) ---
    if (zigbeeDriver) {
        try {
            await zigbeeDriver.start();
        } catch (err) {
            logger.error(`Zigbee initial start failed (will retry): ${err.message}`);
        }
    }

    // --- Graceful shutdown ---
    async function shutdown(signal) {
        logger.info(`Received ${signal} — shutting down`);
        
        // Dispose domain adapters
        try {
            for (const [, adapters] of domainAdapters.lights) {
                for (const adapter of adapters) {
                    try { await adapter.dispose(); } catch (err) { logger.warn(`Adapter dispose error: ${err.message}`); }
                }
            }
            for (const [, adapters] of domainAdapters.switches) {
                for (const adapter of adapters) {
                    try { await adapter.dispose(); } catch (err) { logger.warn(`Adapter dispose error: ${err.message}`); }
                }
            }
            for (const [, adapter] of domainAdapters.inputs) {
                try { await adapter.dispose(); } catch (err) { logger.warn(`Adapter dispose error: ${err.message}`); }
            }
            for (const [, adapter] of domainAdapters.outputs) {
                try { await adapter.dispose(); } catch (err) { logger.warn(`Adapter dispose error: ${err.message}`); }
            }
        } catch (err) {
            logger.warn(`Error disposing adapters: ${err.message}`);
        }

        if (zwaveDriver) {
            try { await zwaveDriver.stop(); } catch (err) { logger.warn(`Z-Wave stop error: ${err.message}`); }
        }
        if (zigbeeDriver) {
            try { await zigbeeDriver.stop(); } catch (err) { logger.warn(`Zigbee stop error: ${err.message}`); }
        }
        heartbeat.flush({ state: 'stopping' });
        heartbeat.stop();
        await mqtt.disconnect();
        logger.info('PxB stopped');
        logger.close();
        process.exit(0);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    logger.info('PxB ready');
}

main();
