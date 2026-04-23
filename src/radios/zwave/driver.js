'use strict';

const EventEmitter = require('events');
const logger = require('../../util/logger');

/**
 * ZWaveDriver — lifecycle wrapper around zwave-js `Driver`.
 *
 * Responsibilities:
 *   - Singleton-per-port: only one driver instance per configured serial port.
 *   - Exponential-backoff reconnect on fatal driver errors or disconnect.
 *   - Expose a stable status view for the bridge heartbeat (`getStatus()`).
 *   - Emit `warning` events for the bridge to publish over MQTT.
 *
 * This class does NOT subscribe to node-level events (phase 1.3).
 *
 * Events emitted:
 *   'connected'     — driver is ready and network usable
 *   'disconnected'  — driver closed / fatal error
 *   'warning'       — { severity, code, message, context } for MQTT publish
 *   'state-changed' — one of: starting|connected|degraded|error|stopped
 */
class ZWaveDriver extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.port        - stable serial path
     * @param {object} [opts.keys]      - { s0, s2_unauth, s2_auth, s2_access } hex strings
     * @param {string} [opts.cacheDir]  - zwave-js cache directory
     * @param {object} [opts.driverFactory] - injectable for tests; defaults to `require('zwave-js').Driver`
     * @param {number} [opts.backoffMinMs=1000]
     * @param {number} [opts.backoffMaxMs=30000]
     */
    constructor(opts) {
        super();
        if (!opts || !opts.port) throw new Error('ZWaveDriver: port is required');

        this._port = opts.port;
        this._keys = opts.keys || {};
        this._cacheDir = opts.cacheDir;
        this._driverFactory = opts.driverFactory || null; // lazy-loaded from zwave-js if null
        this._backoffMinMs = opts.backoffMinMs ?? 1000;
        this._backoffMaxMs = opts.backoffMaxMs ?? 30_000;

        this._driver = null;
        this._state = 'stopped'; // starting|connected|degraded|error|stopped
        this._lastError = null;
        this._currentBackoff = this._backoffMinMs;
        this._reconnectTimer = null;
        this._shuttingDown = false;
    }

    get state() { return this._state; }
    get connected() { return this._state === 'connected'; }
    get lastError() { return this._lastError; }

    /**
     * Expose the underlying zwave-js Controller when connected. Returns null otherwise.
     * Used by the Inclusion FSM and node-command handler; all writes should guard on `connected`.
     */
    get controller() {
        return this._driver?.controller || null;
    }

    /** Expose the raw zwave-js Driver. Prefer `controller` and event forwarding. */
    get rawDriver() {
        return this._driver;
    }

    /** Return the number of nodes known to the controller. Safe when disconnected. */
    get nodeCount() {
        try {
            return this._driver?.controller?.nodes?.size ?? 0;
        } catch {
            return 0;
        }
    }

    /** Status view for heartbeat. */
    getStatus() {
        return {
            enabled: true,
            connected: this.connected,
            port: this._port,
            node_count: this.nodeCount,
            state: this._state,
            last_error: this._lastError,
        };
    }

    /**
     * Start the driver. Returns a promise that resolves when `driver ready` fires,
     * or rejects if the initial start() call throws.
     * After the first start, failures trigger reconnect; they do NOT reject this promise.
     */
    async start() {
        if (this._state !== 'stopped') {
            throw new Error(`ZWaveDriver.start() called in state "${this._state}"`);
        }
        this._shuttingDown = false;
        return this._attachAndStart();
    }

    async _attachAndStart() {
        this._setState('starting');

        // Lazy-load zwave-js only when actually starting (so tests without it installed still pass)
        let factory = this._driverFactory;
        if (!factory) {
            try {
                const { Driver } = require('zwave-js');
                factory = (port, opts) => new Driver(port, opts);
            } catch (err) {
                this._lastError = `zwave-js not available: ${err.message}`;
                this._setState('error');
                this.emit('warning', { severity: 'error', code: 'ZWAVE_LIB_MISSING', message: this._lastError, context: {} });
                throw err;
            }
        }

        const driverOpts = this._buildDriverOptions();
        try {
            this._driver = factory(this._port, driverOpts);
        } catch (err) {
            this._onFatalError(err, 'ZWAVE_DRIVER_CONSTRUCT_FAILED');
            this._scheduleReconnect();
            return;
        }

        this._wireEvents(this._driver);

        try {
            await this._driver.start();
        } catch (err) {
            this._onFatalError(err, 'ZWAVE_START_FAILED');
            this._scheduleReconnect();
            return;
        }

        // After start() resolves, wait for 'driver ready' (emitted by zwave-js
        // once the controller interview completes). Some mock drivers emit it
        // synchronously inside start(); guard for already-connected.
        if (this._state !== 'connected') {
            // remain 'starting' — 'driver ready' handler will flip to 'connected'
        }
    }

    _buildDriverOptions() {
        const opts = {
            logConfig: {
                enabled: !!process.env.ZWAVE_DEBUG,
                level: process.env.ZWAVE_DEBUG || 'info',
                logToFile: !!process.env.ZWAVE_DEBUG,
                filename: '/opt/paradox/logs/pzb/zwave-js.log',
            },
            emitValueUpdateAfterSetValue: true,
        };
        if (this._cacheDir) opts.storage = { cacheDir: this._cacheDir };

        const keys = this._keys || {};
        const sk = {};
        if (keys.s0) sk.S0_Legacy = hexToBuffer(keys.s0);
        if (keys.s2_unauth) sk.S2_Unauthenticated = hexToBuffer(keys.s2_unauth);
        if (keys.s2_auth) sk.S2_Authenticated = hexToBuffer(keys.s2_auth);
        if (keys.s2_access) sk.S2_AccessControl = hexToBuffer(keys.s2_access);
        if (Object.keys(sk).length) opts.securityKeys = sk;

        return opts;
    }

    _wireEvents(driver) {
        driver.on('driver ready', () => {
            this._currentBackoff = this._backoffMinMs; // reset backoff on success
            this._lastError = null;
            this._setState('connected');
            logger.info(`Z-Wave driver ready — ${this.nodeCount} node(s) known`);
            // Wire controller events now that the controller is available.
            this._wireControllerEvents(driver);
            // Subscribe to per-node value updates now that the controller is ready.
            this._subscribeNodeEvents(driver);
            this.emit('connected', driver);
        });

        driver.on('error', (err) => {
            // Non-fatal error: record + surface as warning, but keep running.
            // zwave-js will emit a separate fatal path (destroy/start failure) if recovery fails.
            this._lastError = err?.message || String(err);
            logger.warn(`Z-Wave driver error: ${this._lastError}`);
            this.emit('warning', {
                severity: 'warn',
                code: 'ZWAVE_DRIVER_ERROR',
                message: this._lastError,
                context: { port: this._port },
            });
            if (this._state === 'connected') this._setState('degraded');
        });

        // Hook newly included nodes so we start receiving their value updates immediately.
        driver.on('node added', (node) => {
            this._subscribeNode(node);
        });

        // zwave-js emits 'driver ready' once. For serial disconnect scenarios, it
        // destroys the driver and we must rebuild. We hook 'all nodes ready' as a
        // benign info marker and detect disconnect via start() rejection and
        // an explicit 'destroy' surfacing through error.
        driver.on('all nodes ready', () => {
            logger.info('Z-Wave all nodes ready');
        });

    }

    /** Wire controller-level events (inclusion, node added/removed).
     *  Must be called AFTER 'driver ready' fires, when driver.controller is valid.
     */
    _wireControllerEvents(driver) {
        const controller = driver.controller;
        if (!controller || typeof controller.on !== 'function') return;

        // Forward controller-level inclusion/exclusion events so the Inclusion FSM
        // and discovery layer can react without touching zwave-js directly.
        const forward = (src, dst) => {
            controller.on(src, (...args) => this.emit(dst, ...args));
        };
        forward('inclusion started', 'inclusion-started');
        forward('inclusion stopped', 'inclusion-stopped');
        forward('inclusion failed', 'inclusion-failed');
        forward('exclusion started', 'exclusion-started');
        forward('exclusion stopped', 'exclusion-stopped');
        forward('exclusion failed', 'exclusion-failed');

        controller.on('node added', (node, _result) => {
            // Subscribe for value updates immediately (inclusion interview will complete later).
            this._subscribeNode(node);
            this.emit('zwave-node-added', {
                nodeId: node.id,
                manufacturerId: node.manufacturerId ?? null,
                productType: node.productType ?? null,
                productId: node.productId ?? null,
                deviceClass: node.deviceClass?.specific?.label ?? null,
            });
        });

        controller.on('node removed', (node, _reason) => {
            this.emit('zwave-node-removed', { nodeId: node.id });
        });
    }

    /** Subscribe to value-update and status events for every known node. */
    _subscribeNodeEvents(driver) {
        for (const [, node] of driver.controller.nodes) {
            this._subscribeNode(node);
        }
    }

    /** Subscribe to a single zwave-js node's events and forward them. */
    _subscribeNode(node) {
        node.on('value updated', (n, args) => {
            this.emit('node-value-updated', {
                nodeId: n.id,
                commandClass: args.commandClass,
                commandClassName: args.commandClassName,
                property: args.propertyName ?? args.property,
                propertyKey: args.propertyKey,
                newValue: args.newValue,
                oldValue: args.oldValue,
            });
        });

        node.on('interview completed', (n) => {
            logger.info(`Z-Wave node ${n.id} interview completed`);
            this.emit('node-status-changed', { nodeId: n.id, status: 'ready' });
        });

        node.on('interview failed', (n, args) => {
            logger.warn(`Z-Wave node ${n.id} interview failed: ${args?.errorMessage || 'unknown'}`);
            this.emit('node-status-changed', { nodeId: n.id, status: 'failed' });
        });

        node.on('dead', (n) => {
            logger.warn(`Z-Wave node ${n.id} is dead`);
            this.emit('node-status-changed', { nodeId: n.id, status: 'failed' });
        });

        node.on('alive', (n) => {
            logger.info(`Z-Wave node ${n.id} is alive`);
            this.emit('node-status-changed', { nodeId: n.id, status: 'ready' });
        });
    }

    /** Handle a fatal error path that requires rebuilding the driver. */
    _onFatalError(err, code) {
        this._lastError = err?.message || String(err);
        logger.error(`Z-Wave fatal: ${code} — ${this._lastError}`);
        this.emit('warning', {
            severity: 'error',
            code,
            message: this._lastError,
            context: { port: this._port },
        });
        this._setState('error');
        // Attempt to destroy any partially constructed driver
        try {
            this._driver?.destroy?.();
        } catch { /* ignore */ }
        this._driver = null;
        this.emit('disconnected');
    }

    _scheduleReconnect() {
        if (this._shuttingDown) return;
        if (this._reconnectTimer) return;

        const delay = this._currentBackoff;
        logger.warn(`Z-Wave reconnect scheduled in ${delay}ms`);
        this.emit('warning', {
            severity: 'warn',
            code: 'ZWAVE_RECONNECT_SCHEDULED',
            message: `Reconnect in ${delay}ms`,
            context: { port: this._port, backoff_ms: delay },
        });

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._currentBackoff = Math.min(this._currentBackoff * 2, this._backoffMaxMs);
            this._setState('stopped');
            this._attachAndStart().catch(() => { /* _attachAndStart handles its own failures */ });
        }, delay);

        if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
    }

    _setState(next) {
        if (this._state === next) return;
        const prev = this._state;
        this._state = next;
        logger.debug(`Z-Wave state ${prev} → ${next}`);
        this.emit('state-changed', next, prev);
    }

    /** Graceful shutdown. */
    async stop() {
        this._shuttingDown = true;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._driver) {
            try {
                await this._driver.destroy();
            } catch (err) {
                logger.warn(`Z-Wave destroy error: ${err.message}`);
            }
        }
        this._driver = null;
        this._setState('stopped');
    }
}

function hexToBuffer(hex) {
    const clean = String(hex).replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
    return Buffer.from(clean, 'hex');
}

module.exports = { ZWaveDriver };
