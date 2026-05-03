'use strict';

const AdapterBase = require('../adapter-base');

class LightZoneAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger, memberAdapters }) {
        super({ name: 'LightZoneAdapter', config, mqttClient, logger });

        this.memberAdapters = memberAdapters instanceof Map ? memberAdapters : new Map();
        this._subscribed = false;
    }

    async init() {
        this._assertNotDisposed();

        if (this.memberAdapters.size === 0) {
            throw new Error('LightZoneAdapter: at least one member adapter is required');
        }

        const commandTopic = `${this.config.topic}/commands`;
        this.mqttClient.subscribe(commandTopic, (topic, message) => {
            this._handleCommand(message).catch((err) => {
                this.logger.error(`LightZoneAdapter: command handler error: ${err.message}`);
            });
        });
        this._subscribed = true;

        this._publishState();
        this.logger.info(`LightZoneAdapter: initialized zone ${this.config.topic} with ${this.memberAdapters.size} members`);
    }

    async executeCommand(payload) {
        this._assertNotDisposed();

        if (!payload || typeof payload !== 'object') {
            this.publishWarning('LIGHT_ZONE_CMD_INVALID', 'Command payload must be a JSON object');
            return;
        }

        const entries = Array.from(this.memberAdapters.entries());
        const settled = await Promise.allSettled(entries.map(async ([label, adapter]) => {
            const result = await adapter.executeCommand(payload);
            return { label, result };
        }));

        const successful = [];
        const failures = [];
        const warned = [];

        settled.forEach((result, index) => {
            const label = entries[index][0];
            if (result.status === 'fulfilled') {
                successful.push(label);
                if (result.value.result && result.value.result.warning) {
                    warned.push({ label, warning: result.value.result.warning });
                    this.logger.warn(`LightZoneAdapter: member '${label}' degraded: ${result.value.result.warning}`);
                }
                return;
            }

            failures.push({ label, error: result.reason ? result.reason.message : 'Unknown error' });
            this.logger.warn(`LightZoneAdapter: member '${label}' command failed: ${result.reason ? result.reason.message : 'Unknown error'}`);
        });

        if (failures.length === entries.length) {
            this.publishWarning('LIGHT_ZONE_ALL_MEMBERS_FAILED', 'All light members failed to execute command', {
                failures,
            });
            throw new Error(`All light members failed: ${failures.map((f) => `${f.label}: ${f.error}`).join('; ')}`);
        }

        if (failures.length > 0 || warned.length > 0) {
            this.publishWarning('LIGHT_ZONE_MEMBER_COMMAND_FAILED', 'One or more light members failed to execute command', {
                failures,
                warned,
                successful,
            });
        }

        this._publishState();
    }

    handleStateUpdate(_state) {
        this._publishState();
    }

    async dispose() {
        this._assertNotDisposed();

        this._markDisposed();
    }

    _publishState() {
        this.publishState({
            type: 'light-zone',
            timestamp: new Date().toISOString(),
            members: Array.from(this.memberAdapters.keys()),
            member_count: this.memberAdapters.size,
        });
    }

    async _handleCommand(message) {
        let payload = message;
        if (typeof message === 'string') {
            payload = JSON.parse(message);
        }
        await this.executeCommand(payload);
    }
}

module.exports = LightZoneAdapter;
