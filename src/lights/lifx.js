/**
 * src/lights/lifx.js — LIFX light adapter for PxB
 *
 * Manages LIFX smart light control via the LIFX Cloud HTTP API.
 * Extends AdapterBase and publishes state/events to MQTT.
 *
 * API reference: https://api.developer.lifx.com/
 */

'use strict';

const https = require('https');
const AdapterBase = require('../adapter-base');

/**
 * LifxAdapter — Controls LIFX lights via the LIFX Cloud REST API.
 *
 * Config keys expected:
 *   - topic: MQTT topic for this zone
 *   - api_key: LIFX personal access token
 *   - selector: Device selector (e.g., 'all', 'label:Ceiling', 'id:d073d5...')
 *   - brightness: Default brightness 0.0–1.0 (optional, default 1.0)
 *   - timeout_s: HTTP request timeout (optional, default 10)
 */
class LifxAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger }) {
        super({ name: 'LifxAdapter', config, mqttClient, logger });

        this.apiKey = config.api_key;
        this.selector = config.selector || 'all';
        this.brightness = (config.brightness || 100) / 100; // normalize to 0.0-1.0
        this.timeoutMs = (config.timeout_s || 10) * 1000;

        if (!this.apiKey) {
            throw new Error('LifxAdapter: config.api_key is required');
        }

        this.lights = new Map();  // id → { label, connected, power, brightness, ... }
        this.updateTimer = null;
        this._subscribed = false;
    }

    async init() {
        this._assertNotDisposed();
        this.logger.info('LifxAdapter: Initializing');

        try {
            const lights = await this._fetchLights();
            for (const light of lights) {
                this.lights.set(light.id, light);
            }
            this.logger.info(`LifxAdapter: Found ${lights.length} lights`);
        } catch (err) {
            this.publishWarning('LIFX_INIT_FAILED', `Failed to fetch lights: ${err.message}`);
            throw err;
        }

        const commandTopic = `${this.config.topic}/commands`;
        this.mqttClient.subscribe(commandTopic, (msg) => {
            this._handleCommand(msg).catch((err) => {
                this.logger.error(`LifxAdapter: Command handler error: ${err.message}`);
            });
        });
        this._subscribed = true;

        this._publishState();

        this.updateTimer = setInterval(() => {
            this._pollState().catch((err) => {
                this.logger.warn(`LifxAdapter: Poll error: ${err.message}`);
            });
        }, 5000);

        this.logger.info('LifxAdapter: Initialized');
    }

    async executeCommand(payload) {
        this._assertNotDisposed();
        if (!payload || typeof payload !== 'object') {
            this.publishWarning('LIFX_CMD_INVALID', 'Command payload must be a JSON object');
            return;
        }

        const action = payload.action || payload.command;
        try {
            switch (action) {
                case 'setLight': await this._setLight(payload); break;
                case 'allOn':   await this._setState({ power: 'on' }); this.publishEvent('all-on'); break;
                case 'allOff':  await this._setState({ power: 'off' }); this.publishEvent('all-off'); break;
                default:
                    this.publishWarning('LIFX_CMD_UNKNOWN', `Unknown action: ${action}`);
            }
        } catch (err) {
            this.publishWarning('LIFX_CMD_FAILED', `Command failed: ${err.message}`, { action });
        }
    }

    handleStateUpdate(state) {
        // LIFX is command-driven; no upstream radio state integration needed.
    }

    async dispose() {
        this._assertNotDisposed();

        if (this.updateTimer) { clearInterval(this.updateTimer); this.updateTimer = null; }

        if (this._subscribed) {
            this.mqttClient.unsubscribe(`${this.config.topic}/commands`).catch((err) => {
                this.logger.warn(`LifxAdapter: Unsubscribe error: ${err.message}`);
            });
            this._subscribed = false;
        }

        this._markDisposed();
        this.logger.info('LifxAdapter: Disposed');
    }

    // ---- Private Methods ----

    async _fetchLights() {
        const resp = await this._apiGet(`/v1/lights/${encodeURIComponent(this.selector)}`);
        return Array.isArray(resp) ? resp : [];
    }

    async _setLight(payload) {
        const { power, brightness, hue, saturation, kelvin, duration } = payload;
        const body = {};
        if (power !== undefined) body.power = power ? 'on' : 'off';
        if (brightness !== undefined) body.brightness = Math.max(0, Math.min(1, brightness / 100));
        if (hue !== undefined) body.hue = hue;
        if (saturation !== undefined) body.saturation = saturation;
        if (kelvin !== undefined) body.kelvin = kelvin;
        if (duration !== undefined) body.duration = duration;

        const resp = await this._apiPut(`/v1/lights/${encodeURIComponent(this.selector)}/state`, body);
        if (resp && resp.results && resp.results.every((r) => r.status === 'ok' || r.status === 'timed_out')) {
            this.publishEvent('light-updated', { selector: this.selector });
            await this._pollState();
        } else {
            throw new Error(`LIFX API error: ${JSON.stringify(resp)}`);
        }
    }

    async _setState(body) {
        const resp = await this._apiPut(`/v1/lights/${encodeURIComponent(this.selector)}/state`, body);
        if (!resp || !resp.results) throw new Error(`LIFX API error: ${JSON.stringify(resp)}`);
        await this._pollState();
    }

    async _pollState() {
        try {
            const lights = await this._fetchLights();
            for (const light of lights) { this.lights.set(light.id, light); }
            this._publishState();
        } catch (err) {
            this.logger.warn(`LifxAdapter: Poll failed: ${err.message}`);
        }
    }

    _publishState() {
        const lights = {};
        for (const [id, light] of this.lights) {
            lights[id] = {
                label: light.label,
                on: light.power === 'on',
                brightness: Math.round((light.color?.brightness || 0) * 100),
                connected: light.connected !== false,
            };
        }
        this.publishState({ type: 'lifx', timestamp: new Date().toISOString(), lights });
    }

    async _handleCommand(msg) {
        try {
            await this.executeCommand(JSON.parse(msg));
        } catch (err) {
            this.logger.error(`LifxAdapter: Failed to parse command: ${err.message}`);
        }
    }

    async _apiGet(path) {
        return this._apiRequest('GET', path, null);
    }

    async _apiPut(path, body) {
        return this._apiRequest('PUT', path, body);
    }

    async _apiRequest(method, path, body) {
        return new Promise((resolve, reject) => {
            const data = body ? JSON.stringify(body) : null;
            const options = {
                hostname: 'api.lifx.com',
                port: 443,
                path,
                method,
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
                },
                timeout: this.timeoutMs,
            };

            const req = https.request(options, (res) => {
                let respData = '';
                res.on('data', (chunk) => { respData += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(respData)); } catch (e) {
                        reject(new Error(`Invalid JSON: ${e.message}`));
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error(`HTTP timeout (${this.timeoutMs}ms)`)); });
            if (data) req.write(data);
            req.end();
        });
    }
}

module.exports = LifxAdapter;
