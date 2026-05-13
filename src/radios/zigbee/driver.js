'use strict';

const EventEmitter = require('events');
const path = require('path');
const logger = require('../../util/logger');
const { usbReset } = require('../../util/usb-reset');

/**
 * ZigbeeDriver — lifecycle wrapper around the `zigbee-herdsman` Controller.
 *
 * Mirrors the responsibilities of `ZWaveDriver` so the bridge can treat both
 * radios uniformly:
 *   - Singleton-per-port Controller construction.
 *   - Exponential-backoff reconnect on fatal errors or `adapterDisconnected`.
 *   - Expose a stable status view for the bridge heartbeat (`getStatus()`).
 *   - Emit `warning` events for the bridge to publish over MQTT.
 *   - Forward per-device events (`deviceJoined`, `deviceLeave`, `message`,
 *     `deviceInterview`) in a normalized shape for the events layer.
 *
 * The actual `zigbee-herdsman` import is lazy so tests (and environments
 * without the library installed) can inject a factory.
 *
 * Events emitted:
 *   'connected'            — controller.start() resolved and adapter is ready
 *   'disconnected'         — controller closed / fatal error
 *   'warning'              — { severity, code, message, context }
 *   'state-changed'        — starting|connected|degraded|error|stopped
 *   'zigbee-device-joined' — { ieee, networkAddress, modelId, manufacturerName }
 *   'zigbee-device-left'   — { ieee }
 *   'zigbee-device-interview' — { ieee, status }
 *   'zigbee-message'       — { ieee, endpointId, cluster, type, data, linkquality }
 *
 * This driver is pinned to the Ember adapter path for Sonoff EFR32MG21
 * coordinators (Dongle-LMG21 / Dongle Plus-E class hardware).
 */
class ZigbeeDriver extends EventEmitter {
    /**
     * @param {object} opts
    * @param {string} opts.port              - stable serial path (e.g. /dev/serial/by-id/...)
    * @param {string} [opts.adapter='ember'] - accepted only as 'ember' (legacy values rejected)
    * @param {number} [opts.baudRate=115200] - serial baud rate
     * @param {string} [opts.databasePath]    - devices DB path
     * @param {object} [opts.network]         - { panId, extendedPanId, channel, networkKey }
     * @param {object} [opts.controllerFactory] - injectable for tests; defaults to herdsman.Controller
     * @param {number} [opts.backoffMinMs=1000]
     * @param {number} [opts.backoffMaxMs=30000]
     * @param {import('../../bridge/subsystem-registry').SubsystemRegistry} [opts.registry]
     *   - If provided, the driver registers itself for fault containment.
     */
    constructor(opts) {
        super();
        if (!opts || !opts.port) throw new Error('ZigbeeDriver: port is required');
        if (opts.adapter && opts.adapter !== 'ember') {
            throw new Error(`ZigbeeDriver: unsupported adapter "${opts.adapter}" (expected "ember")`);
        }

        this._port = opts.port;
        this._adapter = 'ember';
        this._baudRate = opts.baudRate || 115200;
        this._databasePath = opts.databasePath || null;
        this._network = opts.network || null;
        this._controllerFactory = opts.controllerFactory || null;
        this._backoffMinMs = opts.backoffMinMs ?? 1000;
        this._backoffMaxMs = opts.backoffMaxMs ?? 30_000;
        this._startTimeoutMs = opts.startTimeoutMs ?? 15000;

        this._controller = null;
        this._state = 'stopped';
        this._lastError = null;
        this._currentBackoff = this._backoffMinMs;
        this._reconnectTimer = null;
        this._shuttingDown = false;

        if (opts.registry) {
            opts.registry.register({
                id: 'zigbee-driver',
                kind: 'radio',
                criticality: 'optional',
                onCrash: async (_err) => {
                    // Stop the reconnect loop so we don't spin after a contained crash.
                    this._shuttingDown = true;
                    if (this._reconnectTimer) {
                        clearTimeout(this._reconnectTimer);
                        this._reconnectTimer = null;
                    }
                    this._setState('error');
                },
            });
        }
    }

    get state() { return this._state; }
    get connected() { return this._state === 'connected'; }
    get lastError() { return this._lastError; }

    /** Expose the underlying herdsman Controller when connected. */
    get controller() { return this._controller; }

    /** Number of devices known to the coordinator (excluding coordinator itself). */
    get deviceCount() {
        try {
            const devs = this._controller?.getDevices?.() || [];
            // herdsman includes the coordinator in getDevices(); filter it out.
            return devs.filter((d) => d && d.type !== 'Coordinator').length;
        } catch {
            return 0;
        }
    }

    /** Status view for the heartbeat. */
    getStatus() {
        return {
            enabled: true,
            connected: this.connected,
            port: this._port,
            adapter: this._adapter,
            baud_rate: this._baudRate,
            device_count: this.deviceCount,
            state: this._state,
            last_error: this._lastError,
        };
    }

    /** Resolve a device by IEEE address; returns null when unknown or disconnected. */
    getDeviceByIeee(ieee) {
        if (!this._controller) return null;
        try {
            const lookup = this._controller.getDeviceByIeeeAddr || this._controller.getDeviceByAddress;
            if (typeof lookup === 'function') {
                return lookup.call(this._controller, normalizeIeee(ieee)) || null;
            }
            const devs = this._controller.getDevices?.() || [];
            const target = normalizeIeee(ieee);
            return devs.find((d) => normalizeIeee(d.ieeeAddr) === target) || null;
        } catch {
            return null;
        }
    }

    /**
     * Start the controller. Rejects only if the first start attempt throws
     * synchronously; async failures trigger reconnect.
     */
    async start() {
        if (this._state !== 'stopped') {
            throw new Error(`ZigbeeDriver.start() called in state "${this._state}"`);
        }
        this._shuttingDown = false;
        return this._attachAndStart();
    }

    async _attachAndStart() {
        this._setState('starting');

        let factory = this._controllerFactory;
        if (!factory) {
            try {
                const { Controller } = require('zigbee-herdsman');
                factory = (opts) => new Controller(opts);
            } catch (err) {
                this._lastError = `zigbee-herdsman not available: ${err.message}`;
                this._setState('error');
                this.emit('warning', {
                    severity: 'error',
                    code: 'ZIGBEE_LIB_MISSING',
                    message: this._lastError,
                    context: {},
                });
                throw err;
            }
        }

        const controllerOpts = this._buildControllerOptions();
        try {
            this._controller = factory(controllerOpts);
        } catch (err) {
            this._onFatalError(err, 'ZIGBEE_CONTROLLER_CONSTRUCT_FAILED');
            this._scheduleReconnect();
            return;
        }

        this._wireEvents(this._controller);

        try {
            // herdsman.start() resolves with 'resumed'|'reset'|'restored'.
            // Guard with a timeout so a wedged serial stack cannot leave us
            // stuck in "starting" forever.
            const result = await withTimeout(
                this._controller.start(),
                this._startTimeoutMs,
                `Zigbee controller start timed out after ${this._startTimeoutMs}ms`
            );
            logger.info(`Zigbee controller start result: ${result ?? 'ok'}`);
            this._currentBackoff = this._backoffMinMs;
            this._lastError = null;
            this._setState('connected');
            this.emit('connected', this._controller);
        } catch (err) {
            // Always stop the controller to release the serial port before
            // scheduling a reconnect — otherwise the next attempt gets
            // "Cannot lock port" immediately.
            try { await this._controller?.stop(); } catch { /* ignore */ }
            this._controller = null;

            // On the very first startup attempt, a stuck EZSP state from a
            // prior unclean process exit can produce HOST_FATAL_ERROR or EBUSY.
            // Try a USB-level reset once before falling back to timed reconnect.
            if (this._isFirstAttempt() && isSerialFatal(err)) {
                logger.warn(`Zigbee start failed (${err.message}) — attempting USB reset of ${this._port}`);
                this.emit('warning', {
                    severity: 'warn',
                    code: 'ZIGBEE_USB_RESET_ATTEMPT',
                    message: `Serial fatal on first start — attempting USB reset`,
                    context: { port: this._port, reason: err.message },
                });
                try {
                    await usbReset(this._port);
                    logger.info(`Zigbee USB reset complete — retrying start`);
                } catch (resetErr) {
                    logger.warn(`Zigbee USB reset failed: ${resetErr.message} — continuing to backoff reconnect`);
                }
                // Fall through to normal reconnect (backoff stays at min, so it fires quickly)
            }

            this._onFatalError(err, 'ZIGBEE_START_FAILED');
            this._scheduleReconnect();
        }
    }

    _buildControllerOptions() {
        const opts = {
            serialPort: { path: this._port, adapter: this._adapter, baudRate: this._baudRate },
            acceptJoining: false,
        };
        if (this._databasePath) {
            opts.databasePath = this._databasePath;
            opts.databaseBackupPath = `${this._databasePath}.backup`;
            opts.backupPath = path.join(path.dirname(this._databasePath), 'zigbee-network.db');
        }
        if (this._network) opts.network = this._network;
        return opts;
    }

    _wireEvents(controller) {
        if (typeof controller.on !== 'function') return;

        controller.on('adapterDisconnected', () => {
            this._lastError = 'adapter disconnected';
            logger.warn('Zigbee adapter disconnected');
            this.emit('warning', {
                severity: 'warn',
                code: 'ZIGBEE_DISCONNECTED',
                message: 'Zigbee serial adapter disconnected',
                context: { port: this._port },
            });
            if (this._state === 'connected') this._setState('degraded');
            // Tear down and rebuild — await so the serial port is released
            // before the reconnect attempt opens it again.
            const stopAndReconnect = async () => {
                try { await controller.stop?.(); } catch { /* ignore */ }
                this._controller = null;
                this._setState('stopped');
                this.emit('disconnected');
                this._scheduleReconnect();
            };
            stopAndReconnect().catch(() => { /* ignore */ });
        });

        controller.on('deviceJoined', (event) => {
            const device = event?.device || event;
            if (!device) return;
            this.emit('zigbee-device-joined', {
                ieee: normalizeIeee(device.ieeeAddr),
                networkAddress: device.networkAddress ?? null,
                modelId: device.modelID ?? device.modelId ?? null,
                manufacturerName: device.manufacturerName ?? null,
            });
        });

        controller.on('deviceAnnounce', (event) => {
            const device = event?.device || event;
            if (!device) return;
            // Treat an announce as a reachability signal.
            this.emit('zigbee-device-announce', {
                ieee: normalizeIeee(device.ieeeAddr),
            });
        });

        controller.on('deviceLeave', (event) => {
            const ieee = normalizeIeee(event?.ieeeAddr || event?.device?.ieeeAddr);
            if (!ieee) return;
            this.emit('zigbee-device-left', { ieee });
        });

        controller.on('deviceInterview', (event) => {
            const device = event?.device;
            const status = event?.status;
            if (!device) return;
            this.emit('zigbee-device-interview', {
                ieee: normalizeIeee(device.ieeeAddr),
                status, // 'started' | 'successful' | 'failed'
            });
        });

        controller.on('message', (msg) => {
            if (!msg || !msg.device) return;
            this.emit('zigbee-message', {
                ieee: normalizeIeee(msg.device.ieeeAddr),
                endpointId: msg.endpoint?.ID ?? null,
                cluster: msg.cluster || null,
                type: msg.type || null,
                data: msg.data || {},
                linkquality: msg.linkquality ?? null,
            });
        });

        controller.on('permitJoinChanged', (event) => {
            this.emit('zigbee-permit-join-changed', {
                permitted: !!event?.permitted,
                time: event?.time ?? null,
            });
        });
    }

    _onFatalError(err, code) {
        this._lastError = err?.message || String(err);
        logger.error(`Zigbee fatal: ${code} — ${this._lastError}`);
        this.emit('warning', {
            severity: 'error',
            code,
            message: this._lastError,
            context: { port: this._port, adapter: this._adapter },
        });
        this._setState('error');
        // Note: callers in _attachAndStart already awaited controller.stop() before
        // reaching here; this path covers any remaining direct-call scenarios.
        const ctrl = this._controller;
        this._controller = null;
        this.emit('disconnected');
        if (ctrl) {
            Promise.resolve(ctrl.stop?.()).catch(() => { /* ignore */ });
        }
    }

    _scheduleReconnect() {
        if (this._shuttingDown) return;
        if (this._reconnectTimer) return;

        const delay = this._currentBackoff;
        logger.warn(`Zigbee reconnect scheduled in ${delay}ms`);
        this.emit('warning', {
            severity: 'warn',
            code: 'ZIGBEE_RECONNECT_SCHEDULED',
            message: `Reconnect in ${delay}ms`,
            context: { port: this._port, backoff_ms: delay },
        });

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._currentBackoff = Math.min(this._currentBackoff * 2, this._backoffMaxMs);
            this._setState('stopped');
            this._attachAndStart().catch(() => { /* internal handlers reported it */ });
        }, delay);

        if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
    }

    _setState(next) {
        if (this._state === next) return;
        const prev = this._state;
        this._state = next;
        logger.debug(`Zigbee state ${prev} → ${next}`);
        this.emit('state-changed', next, prev);
    }

    /** True only on the very first start attempt (backoff hasn't advanced yet). */
    _isFirstAttempt() {
        return this._currentBackoff === this._backoffMinMs;
    }

    async stop() {
        this._shuttingDown = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._controller) {
            try {
                if (typeof this._controller.permitJoin === 'function') {
                    try { await this._controller.permitJoin(false); } catch { /* ignore */ }
                }
                await this._controller.stop?.();
            } catch (err) {
                logger.warn(`Zigbee stop error: ${err.message}`);
            }
        }
        this._controller = null;
        this._setState('stopped');
    }
}

/** Normalize IEEE addresses to lowercase 0x-prefixed 16-hex-digit form. */
function normalizeIeee(raw) {
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '');
    if (!s) return null;
    return `0x${s.padStart(16, '0')}`;
}

/**
 * Returns true when the error indicates a serial-port-level failure that a
 * USB reset could recover from (stuck EZSP state, port busy, port disappeared).
 */
function isSerialFatal(err) {
    const msg = (err?.message || '').toLowerCase();
    return (
        msg.includes('host_fatal_error') ||
        msg.includes('ebusy') ||
        msg.includes('resource busy') ||
        msg.includes('enoent') ||
        msg.includes('no such file') ||
        msg.includes('cannot lock port') ||
        msg.includes('failed to open')
    );
}

function withTimeout(promise, timeoutMs, message) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
        }),
    ]);
}

module.exports = { ZigbeeDriver, normalizeIeee };
