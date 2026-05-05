/**
 * AdapterBase — Abstract base class for all I/O domain adapters.
 *
 * All adapters in src/lights/, src/switches/, src/inputs/, src/outputs/ must
 * extend this class or implement its interface exactly.
 *
 * Lifecycle:
 *   constructor(opts) → init() → (handleStateUpdate, executeCommand loop) → dispose()
 *
 * Guarantees:
 *   - init() called once per adapter lifecycle; idempotent (safe to call multiple times)
 *   - executeCommand(payload) called when a command arrives on {config.topic}/commands
 *   - handleStateUpdate(state) called when upstream state changes (e.g., radio event)
 *   - dispose() called before process exit or adapter restart; must clean up all resources
 *   - Never modify state after dispose() is called
 */

class AdapterBase {
    /**
     * @param {object} opts
     * @param {string} opts.name - Human-readable adapter name (e.g., "HueAdapter")
     * @param {object} opts.config - Parsed INI section for this zone
     *                               (e.g., { topic: 'paradox/houdini/lights/mirror', ... })
     * @param {import('./mqtt/client').MqttClient} opts.mqttClient - Shared MQTT client
     * @param {import('./util/logger')} opts.logger - Shared logger instance
     */
    constructor({ name, config, mqttClient, logger }) {
        if (!config || !config.topic) {
            throw new Error(`AdapterBase: config.topic is required (got ${JSON.stringify(config)})`);
        }
        if (!mqttClient) {
            throw new Error('AdapterBase: mqttClient is required');
        }
        if (!logger) {
            throw new Error('AdapterBase: logger is required');
        }

        this.name = name;
        this.config = config;
        this.mqttClient = mqttClient;
        this.logger = logger;
        this._disposed = false;
    }

    /**
     * Initialize the adapter: open hardware connections, subscribe to command topics,
     * publish initial state. Must be idempotent (safe to call again).
     *
     * @returns {Promise<void>}
     * @throws {Error} If initialization fails fatally. Caller will mark adapter failed.
     */
    async init() {
        throw new Error(`${this.name}.init() not implemented`);
    }

    /**
     * Execute an inbound MQTT command payload.
     *
     * @param {object} payload - Parsed JSON from {topic}/commands message
     * @returns {Promise<void>}
     *
     * On success: adapter updates hardware state and publishes any relevant events.
     * On non-fatal error: publish to {topic}/warnings and return normally.
     * On fatal error: publish warning and throw; caller will mark adapter failed.
     */
    async executeCommand(_payload) {
        throw new Error(`${this.name}.executeCommand() not implemented`);
    }

    /**
     * Called when upstream state changes for this node (e.g., a radio/hardware event).
     * Adapter should publish a retained state message to {config.topic}/state if appropriate.
     *
     * @param {object} state - Node state object (shape varies by adapter type)
     * @returns {void}
     */
    handleStateUpdate(_state) {
        throw new Error(`${this.name}.handleStateUpdate() not implemented`);
    }

    /**
     * Shut down the adapter: unsubscribe from MQTT, close hardware connections,
     * release timers, cleanup. After this is called, no further state mutations
     * or MQTT publishes should occur.
     *
     * @returns {Promise<void>}
     */
    async dispose() {
        throw new Error(`${this.name}.dispose() not implemented`);
    }

    /**
     * Publish a warning to the adapter's warnings topic.
     * Use this for non-fatal errors; fatal errors should throw.
     *
     * @param {string} code - Machine-readable warning code (e.g., 'DEVICE_UNREACHABLE')
     * @param {string} message - Human-readable message
     * @param {object} [details] - Optional extra details
     */
    publishWarning(code, message, details = {}) {
        if (this._disposed) {
            this.logger.warn(`${this.name}: publishWarning() called after dispose() — ignoring`, { code });
            return;
        }
        const topic = `${this.config.topic}/warnings`;
        const payload = { code, message, timestamp: new Date().toISOString(), ...details };
        this.mqttClient.publish(topic, JSON.stringify(payload), { retain: false });
    }

    /**
     * Publish state to the adapter's state topic (retained).
     *
     * @param {object} state - State object to publish
     */
    publishState(state) {
        if (this._disposed) {
            this.logger.warn(`${this.name}: publishState() called after dispose() — ignoring`);
            return;
        }
        const topic = `${this.config.topic}/state`;
        this.mqttClient.publish(topic, JSON.stringify(state), { retain: true });
    }

    /**
     * Publish an event (non-retained) to the adapter's events topic.
     *
     * @param {string} event - Event name (e.g., 'scene-activated')
     * @param {object} [payload] - Optional event details
     */
    publishEvent(event, payload = {}) {
        if (this._disposed) {
            this.logger.warn(`${this.name}: publishEvent() called after dispose() — ignoring`, { event });
            return;
        }
        const topic = `${this.config.topic}/events`;
        const msg = { event, timestamp: new Date().toISOString(), ...payload };
        this.mqttClient.publish(topic, JSON.stringify(msg), { retain: false });
    }

    /**
     * Mark this adapter as disposed. Called internally by dispose().
     */
    _markDisposed() {
        this._disposed = true;
    }

    /**
     * Check if adapter is disposed; throw if called after dispose.
     * Subclasses can call this in any method that shouldn't run post-dispose.
     */
    _assertNotDisposed() {
        if (this._disposed) {
            throw new Error(`${this.name}: Operation called after dispose()`);
        }
    }
}

module.exports = AdapterBase;
