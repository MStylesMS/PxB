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
const { SubsystemRegistry } = require('./bridge/subsystem-registry');
const { ZWaveDriver } = require('./radios/zwave/driver');
const { ZWaveEvents } = require('./radios/zwave/events');
const { ZWaveInclusion } = require('./radios/zwave/inclusion');
const { ZigbeeDriver } = require('./radios/zigbee/driver');
const { ZigbeeEvents } = require('./radios/zigbee/events');
const { ZigbeeInclusion } = require('./radios/zigbee/inclusion');
const { NodeCommandHandler } = require('./bridge/node-command-handler');
const { DiscoveredStore } = require('./discovery/discovered-store');
const { bridgeTopics } = require('./mqtt/contract');
const HueAdapter = require('./lights/hue');
const WizAdapter = require('./lights/wiz');
const LifxAdapter = require('./lights/lifx');
const DmxAdapter = require('./lights/dmx');
const ShellyAdapter = require('./switches/shelly');
const DmxEffectAdapter = require('./effects/dmx');
const LightZoneAdapter = require('./lights/zone');
const UnavailableOutputAdapter = require('./adapters/unavailable-output');
const { DmxUniverse } = require('./dmx/universe');

const LOCK_DIR_CANDIDATES = ['/run/paradox', '/tmp/paradox'];
let singletonLockPath = null;
let singletonLockFd = null;

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
        process.stderr.write('Usage: pxb --config <path/to/pxb.ini>\n');
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

    await acquireSingletonLock();

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

    // --- Subsystem registry (created before any components) ---
    const registry = new SubsystemRegistry();

    // --- MQTT client ---
    const mqtt = new MqttClient(config.mqtt, registry);

    // Wire publishWarning into registry so crash events surface on MQTT.
    // Done after mqtt is created; the registry was created before mqtt so ordering is safe.
    registry._publishWarning = (w) => publishBridgeWarning(mqtt, config.mqtt.base_topic, w);

    // --- Node registry (always constructed; tracks runtime node state) ---
    const nodeRegistry = new NodeRegistry(config.nodes);

    // --- DMX universe (constructed eagerly; started after radios) ---
    let dmxUniverse = null;
    if (config.dmx && config.dmx.enabled) {
        dmxUniverse = new DmxUniverse({
            port:          config.dmx.port,
            interface:     config.dmx.interface,
            refresh_hz:    config.dmx.refresh_hz,
            universe_size: config.dmx.universe_size,
        });

        dmxUniverse.on('warning', (w) => {
            publishBridgeWarning(mqtt, config.mqtt.base_topic, w);
        });
        dmxUniverse.on('state-changed', () => {
            if (heartbeat) heartbeat.flush();
        });
    }

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
            registry,
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
            registry,
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
            dmx: dmxUniverse
                ? { ...dmxUniverse.getStatus() }
                : (config.dmx ? { enabled: config.dmx.enabled, connected: false } : { enabled: false }),
            nodes: nodeRegistry.getSummary(),
            inclusion,
            subsystems: registry.getSummary(),
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
    const _commandHandler = new BridgeCommandHandler({
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
    const _nodeCommandHandler = new NodeCommandHandler({
        mqttClient: mqtt,
        nodeRegistry,
        zwaveDriver,
        zwaveEvents,
        zigbeeDriver,
        zigbeeEvents,
    });

    // --- Start radios before output adapter initialization ---
    // Light/switch adapter init can block for tens of seconds when devices are
    // unreachable. Start radios first so input events (e.g., contact sensors)
    // are available immediately during degraded output scenarios.
    if (zwaveDriver) {
        try {
            await zwaveDriver.start();
        } catch (err) {
            logger.error(`Z-Wave initial start failed (will retry): ${err.message}`);
        }
    }

    if (zigbeeDriver) {
        try {
            await zigbeeDriver.start();
        } catch (err) {
            logger.error(`Zigbee initial start failed (will retry): ${err.message}`);
        }
    }

    // --- Start DMX universe (after radios) ---
    if (dmxUniverse) {
        try {
            await dmxUniverse.start();
        } catch (err) {
            logger.error(`DMX universe start failed (will retry): ${err.message}`);
        }
    }

    // --- Domain adapters (lights, switches) ---
    const domainAdapters = {
        lights:  new Map(),      // label -> adapter instance
        switches: new Map(),     // label -> adapter instance
        effects:  new Map(),     // label -> adapter instance
    };

    const publishAdapterInitWarning = (topic, label, message) => {
        mqtt.publish(`${topic}/warnings`, {
            code: 'ADAPTER_INIT_FAILED',
            message,
            label,
            timestamp: new Date().toISOString(),
        }, { retain: false });
    };

    const attachUnavailableOutput = async ({ label, backend, domain, config, reason, targetMap }) => {
        if (!config || !config.topic) {
            return;
        }

        const fallback = new UnavailableOutputAdapter({
            config,
            mqttClient: mqtt,
            logger,
            reason,
            label,
            backend,
            domain,
        });

        await fallback.init();
        targetMap.set(label, fallback);
    };

    // Initialize light device adapters first, then light-zone fan-out adapters.
    for (const [label, lightConfig] of Object.entries(config.lights || {})) {
        try {
            let adapter;
            switch (lightConfig.backend) {
                case 'hue':
                    adapter = new HueAdapter({ config: lightConfig, mqttClient: mqtt, logger });
                    break;
                case 'wiz':
                    adapter = new WizAdapter({ config: lightConfig, mqttClient: mqtt, logger });
                    break;
                case 'lifx':
                    adapter = new LifxAdapter({ config: lightConfig, mqttClient: mqtt, logger });
                    break;
                case 'dmx':
                    if (!dmxUniverse) {
                        throw new Error(
                            `backend=dmx requires a configured and enabled [dmx] section. ` +
                            `Add [dmx] to the INI or set enabled = true.`
                        );
                    }
                    adapter = new DmxAdapter({ config: lightConfig, mqttClient: mqtt, logger, universe: dmxUniverse });
                    break;
                default:
                    throw new Error(`Unsupported light backend: ${lightConfig.backend}`);
            }

            adapter._subsystemId = `light-${label}`;
            await adapter.init();
            domainAdapters.lights.set(label, adapter);
            logger.info(`Light adapter '${label}' initialized (${lightConfig.backend})`);

            // Register with the subsystem registry for fault containment.
            // Capture adapter + label in closure so onCrash can clean up correctly.
            const _capturedAdapter = adapter;
            const _capturedConfig = lightConfig;
            registry.register({
                id: `light-${label}`,
                kind: 'output-adapter',
                criticality: 'optional',
                onCrash: async (err) => {
                    try { await _capturedAdapter.dispose(); } catch { /* ignore */ }
                    await attachUnavailableOutput({
                        label,
                        backend: _capturedConfig.backend,
                        domain: 'light',
                        config: _capturedConfig,
                        reason: err instanceof Error ? err.message : String(err),
                        targetMap: domainAdapters.lights,
                    });
                },
            });
        } catch (err) {
            logger.warn(`Light adapter '${label}' failed to initialize: ${err.message}`);
            publishAdapterInitWarning(lightConfig.topic, label, err.message);
            await attachUnavailableOutput({
                label,
                backend: lightConfig.backend,
                domain: 'light',
                config: lightConfig,
                reason: err.message,
                targetMap: domainAdapters.lights,
            });
        }
    }

    for (const [label, zoneConfig] of Object.entries(config.light_zones || {})) {
        try {
            const members = new Map();
            for (const deviceLabel of zoneConfig.devices) {
                const member = domainAdapters.lights.get(deviceLabel);
                if (!member) {
                    logger.warn(`Light zone '${label}' missing initialized member '${deviceLabel}'`);
                    continue;
                }
                members.set(deviceLabel, member);
            }

            if (members.size === 0) {
                throw new Error('No member adapters initialized');
            }

            const zoneAdapter = new LightZoneAdapter({
                config: zoneConfig,
                mqttClient: mqtt,
                logger,
                memberAdapters: members,
            });
            zoneAdapter._subsystemId = `light-zone-${label}`;
            await zoneAdapter.init();

            domainAdapters.lights.set(label, zoneAdapter);
            logger.info(`Light zone '${label}' initialized with ${members.size} members`);

            const _capturedZoneAdapter = zoneAdapter;
            const _capturedZoneConfig = zoneConfig;
            registry.register({
                id: `light-zone-${label}`,
                kind: 'output-adapter',
                criticality: 'optional',
                onCrash: async (err) => {
                    try { await _capturedZoneAdapter.dispose(); } catch { /* ignore */ }
                    await attachUnavailableOutput({
                        label,
                        backend: 'light-zone',
                        domain: 'light-zone',
                        config: _capturedZoneConfig,
                        reason: err instanceof Error ? err.message : String(err),
                        targetMap: domainAdapters.lights,
                    });
                },
            });
        } catch (err) {
            logger.warn(`Light zone '${label}' failed to initialize: ${err.message}`);
            publishAdapterInitWarning(zoneConfig.topic, label, err.message);
            await attachUnavailableOutput({
                label,
                backend: 'light-zone',
                domain: 'light-zone',
                config: zoneConfig,
                reason: err.message,
                targetMap: domainAdapters.lights,
            });
        }
    }

    for (const [label, switchConfig] of Object.entries(config.switches || {})) {
        try {
            let adapter;
            switch (switchConfig.backend) {
                case 'shelly':
                    adapter = new ShellyAdapter({ config: switchConfig, mqttClient: mqtt, logger });
                    break;
                default:
                    throw new Error(`Unsupported switch backend: ${switchConfig.backend}`);
            }

            adapter._subsystemId = `switch-${label}`;
            await adapter.init();
            domainAdapters.switches.set(label, adapter);
            logger.info(`Switch adapter '${label}' initialized (${switchConfig.backend})`);

            const _capturedSwitchAdapter = adapter;
            const _capturedSwitchConfig = switchConfig;
            registry.register({
                id: `switch-${label}`,
                kind: 'output-adapter',
                criticality: 'optional',
                onCrash: async (err) => {
                    try { await _capturedSwitchAdapter.dispose(); } catch { /* ignore */ }
                    await attachUnavailableOutput({
                        label,
                        backend: _capturedSwitchConfig.backend,
                        domain: 'switch',
                        config: _capturedSwitchConfig,
                        reason: err instanceof Error ? err.message : String(err),
                        targetMap: domainAdapters.switches,
                    });
                },
            });
        } catch (err) {
            logger.warn(`Switch adapter '${label}' failed to initialize: ${err.message}`);
            publishAdapterInitWarning(switchConfig.topic, label, err.message);
            await attachUnavailableOutput({
                label,
                backend: switchConfig.backend,
                domain: 'switch',
                config: switchConfig,
                reason: err.message,
                targetMap: domainAdapters.switches,
            });
        }
    }

    // Initialize effect adapters (foggers, strobes, hazers).
    for (const [label, effectConfig] of Object.entries(config.effects || {})) {
        try {
            if (!dmxUniverse) {
                throw new Error(
                    `backend=dmx requires a configured and enabled [dmx] section. ` +
                    `Add [dmx] to the INI or set enabled = true.`
                );
            }

            const adapter = new DmxEffectAdapter({
                config: effectConfig,
                mqttClient: mqtt,
                logger,
                universe: dmxUniverse,
            });

            adapter._subsystemId = `effect-${label}`;
            await adapter.init();
            domainAdapters.effects.set(label, adapter);
            logger.info(`Effect adapter '${label}' initialized (${effectConfig.fixture})`);

            const _capturedEffectAdapter = adapter;
            const _capturedEffectConfig  = effectConfig;
            registry.register({
                id: `effect-${label}`,
                kind: 'output-adapter',
                criticality: 'optional',
                onCrash: async (err) => {
                    try { await _capturedEffectAdapter.dispose(); } catch { /* ignore */ }
                    await attachUnavailableOutput({
                        label,
                        backend: _capturedEffectConfig.backend,
                        domain: 'effect',
                        config: _capturedEffectConfig,
                        reason: err instanceof Error ? err.message : String(err),
                        targetMap: domainAdapters.effects,
                    });
                },
            });
        } catch (err) {
            logger.warn(`Effect adapter '${label}' failed to initialize: ${err.message}`);
            publishAdapterInitWarning(effectConfig.topic, label, err.message);
            await attachUnavailableOutput({
                label,
                backend: effectConfig.backend,
                domain: 'effect',
                config: effectConfig,
                reason: err.message,
                targetMap: domainAdapters.effects,
            });
        }
    }

    // --- Graceful shutdown ---
    async function shutdown(signal) {
        logger.info(`Received ${signal} — shutting down`);
        
        // Dispose domain adapters
        try {
            for (const [, adapter] of domainAdapters.lights) {
                try { await adapter.dispose(); } catch (err) { logger.warn(`Adapter dispose error: ${err.message}`); }
            }
            for (const [, adapter] of domainAdapters.switches) {
                try { await adapter.dispose(); } catch (err) { logger.warn(`Adapter dispose error: ${err.message}`); }
            }
            for (const [, adapter] of domainAdapters.effects) {
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
        if (dmxUniverse) {
            try { await dmxUniverse.dispose(); } catch (err) { logger.warn(`DMX dispose error: ${err.message}`); }
        }
        heartbeat.flush({ state: 'stopping' });
        heartbeat.stop();
        await mqtt.disconnect();
        releaseSingletonLock();
        logger.info('PxB stopped');
        logger.close();
        process.exit(0);
    }

    let shutdownInProgress = false;
    async function safeShutdown(reason) {
        if (shutdownInProgress) return;
        shutdownInProgress = true;
        await shutdown(reason);
    }

    process.on('SIGTERM', () => safeShutdown('SIGTERM'));
    process.on('SIGINT',  () => safeShutdown('SIGINT'));
    process.on('uncaughtException', (err) => {
        const attribution = registry.attribute();
        if (attribution && attribution.criticality === 'optional') {
            // Contained crash: keep the process running, invoke the subsystem's onCrash handler.
            registry.crash(attribution.subsystemId, err).catch((crashErr) => {
                logger.error(`Registry.crash() threw during uncaughtException handling: ${crashErr.message}`);
            });
        } else {
            // Unattributed or fatal: preserve existing shutdown behavior.
            logger.error(`Uncaught exception — shutting down: ${err.stack || err.message}`);
            safeShutdown('CRASH').finally(() => process.exit(1));
        }
    });
    process.on('unhandledRejection', (reason) => {
        const attribution = registry.attribute();
        if (attribution && attribution.criticality === 'optional') {
            // Contained crash: keep the process running.
            const err = reason instanceof Error ? reason : new Error(String(reason));
            registry.crash(attribution.subsystemId, err).catch((crashErr) => {
                logger.error(`Registry.crash() threw during unhandledRejection handling: ${crashErr.message}`);
            });
        } else {
            // Unattributed or fatal: preserve existing shutdown behavior.
            const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
            logger.error(`Unhandled rejection — shutting down: ${msg}`);
            safeShutdown('CRASH').finally(() => process.exit(1));
        }
    });

    logger.info('PxB ready');
}

/**
 * Acquire a singleton lock for PxB. If another PxB instance is holding the lock,
 * terminate it, clean up stale lock state, and retry acquisition.
 */
async function acquireSingletonLock() {
    const fs = require('fs');
    if (!singletonLockPath) {
        singletonLockPath = resolveLockPath(fs);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            singletonLockFd = fs.openSync(singletonLockPath, 'wx');
            fs.writeFileSync(singletonLockFd, `${process.pid}\n`, 'utf8');
            return;
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }

        const existingPid = readLockedPid(fs);
        if (!existingPid || existingPid === process.pid) {
            safeUnlink(fs, singletonLockPath);
            continue;
        }

        terminateProcess(existingPid);
        await waitForProcessExit(existingPid, 3000);
        safeUnlink(fs, singletonLockPath);
    }

    throw new Error(`PxB could not acquire singleton lock at ${singletonLockPath}`);
}

function resolveLockPath(fs) {
    for (const dirPath of LOCK_DIR_CANDIDATES) {
        try {
            fs.mkdirSync(dirPath, { recursive: true });
            const testPath = `${dirPath}/.pxb.lock.test`;
            const fd = fs.openSync(testPath, 'w');
            fs.closeSync(fd);
            fs.unlinkSync(testPath);
            return `${dirPath}/pxb.lock`;
        } catch {
            // try next candidate
        }
    }
    throw new Error('PxB could not find a writable lock directory (/run/paradox or /tmp/paradox)');
}

function readLockedPid(fs) {
    try {
        const raw = fs.readFileSync(singletonLockPath, 'utf8').trim();
        const pid = Number(raw);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

function terminateProcess(pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
}

async function waitForProcessExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (isProcessAlive(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function safeUnlink(fs, filePath) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

function releaseSingletonLock() {
    const fs = require('fs');
    if (singletonLockFd !== null) {
        try { fs.closeSync(singletonLockFd); } catch { /* ignore */ }
        singletonLockFd = null;
    }
    if (singletonLockPath) {
        safeUnlink(fs, singletonLockPath);
    }
}

main();
