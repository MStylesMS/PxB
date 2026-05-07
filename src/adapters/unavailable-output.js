'use strict';

const AdapterBase = require('../adapter-base');

class UnavailableOutputAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger, reason, label, backend, domain }) {
        super({
            name: 'UnavailableOutputAdapter',
            config,
            mqttClient,
            logger,
        });

        this.reason = String(reason || 'output unavailable');
        this.label = String(label || 'unknown');
        this.backend = String(backend || 'unknown');
        this.domain = String(domain || 'output');
        this._subscribed = false;
    }

    async init() {
        this._assertNotDisposed();

        const commandTopic = `${this.config.topic}/commands`;
        this.mqttClient.subscribe(commandTopic, (_topic, payload) => {
            this.executeCommand(payload).catch((err) => {
                this.logger.warn(`Unavailable output '${this.label}' command handling failed: ${err.message}`);
            });
        });
        this._subscribed = true;

        this.publishWarning('OUTPUT_OFFLINE', this.reason, {
            label: this.label,
            backend: this.backend,
            domain: this.domain,
        });

        // Also publish a retained warning payload so late subscribers still see
        // a human-readable offline reason on the warnings topic.
        this.mqttClient.publish(`${this.config.topic}/warnings`, JSON.stringify({
            code: 'OUTPUT_OFFLINE',
            message: `${this.domain} '${this.label}' is unavailable (${this.backend}): ${this.reason}`,
            timestamp: new Date().toISOString(),
            label: this.label,
            backend: this.backend,
            domain: this.domain,
            status: 'offline',
        }), { retain: true });
        // Publish a retained offline state so the UI shows "offline" instead
        // of silently waiting on a state that will never arrive.
        this.publishState({
            status: 'offline',
            reason: this.reason,
            label: this.label,
            backend: this.backend,
            domain: this.domain,
            timestamp: new Date().toISOString(),
        });
    }

    async executeCommand(payload) {
        this._assertNotDisposed();

        const command = payload && typeof payload === 'object'
            ? (payload.command || payload.action || 'unknown')
            : 'unknown';

        const message = `${this.domain} '${this.label}' is unavailable (${this.backend}): ${this.reason}`;
        this.logger.warn(`${message}; rejected command '${command}'`);

        this.publishWarning('COMMAND_UNAVAILABLE', message, {
            command,
            label: this.label,
            backend: this.backend,
            domain: this.domain,
        });
    }

    handleStateUpdate() {
        // No-op: this adapter represents an unavailable target.
    }

    async dispose() {
        this._markDisposed();
        this._subscribed = false;
    }
}

module.exports = UnavailableOutputAdapter;
