/**
 * src/lights/hue.js — Philips Hue light adapter for PxB
 *
 * Manages Philips Hue light control via the Hue Bridge API.
 * Extends AdapterBase and publishes state/events to MQTT.
 */

'use strict';

const AdapterBase = require('../adapter-base');

/**
 * HueAdapter — Controls Philips Hue lights via REST API.
 *
 * Config keys expected:
 *   - topic: MQTT topic for this zone (e.g., 'paradox/houdini/lights/mirror')
 *   - host: Hue Bridge IP address (e.g., '192.168.1.100')
 *   - port: Hue Bridge port (optional, default 80)
 *   - api_key: Hue Bridge API key (or username in v1/v2 API)
 *   - brightness: Default brightness 0–254 (optional, default 100)
 *   - timeout_s: HTTP request timeout in seconds (optional, default 10)
 */
class HueAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger }) {
        super({
            name: 'HueAdapter',
            config,
            mqttClient,
            logger,
        });

        this.host = config.host;
        this.port = config.port || 80;
        this.apiKey = config.api_key;
        this.brightness = config.brightness || 100;
        this.timeoutMs = (config.timeout_s || 10) * 1000;

        if (!this.host || !this.apiKey) {
            throw new Error('HueAdapter: config.host and config.api_key required');
        }

        this.lights = new Map();     // light_id → { state, reachable, ... }
        this.updateTimer = null;
        this._subscribed = false;
    }

    /**
     * Initialize: connect to Hue Bridge, fetch light list, subscribe to commands.
     */
    async init() {
        this._assertNotDisposed();
        this.logger.info(`HueAdapter: Initializing (bridge: ${this.host}:${this.port})`);

        try {
            // Fetch light list from Hue Bridge
            const lights = await this._fetchLights();
            for (const [lightId, lightState] of Object.entries(lights)) {
                this.lights.set(lightId, lightState);
            }
            this.logger.info(`HueAdapter: Found ${lights.length} lights`);
        } catch (err) {
            this.publishWarning('HUE_INIT_FAILED', `Failed to fetch lights: ${err.message}`);
            throw err;
        }

        // Subscribe to command topic
        const commandTopic = `${this.config.topic}/commands`;
        this.mqttClient.subscribe(commandTopic, (msg) => {
            this._handleCommand(msg).catch((err) => {
                this.logger.error(`HueAdapter: Command handler error: ${err.message}`);
            });
        });
        this._subscribed = true;
        this.logger.info(`HueAdapter: Subscribed to ${commandTopic}`);

        // Publish initial state
        this._publishState();

        // Start polling for state updates every 5s
        this.updateTimer = setInterval(() => {
            this._pollState().catch((err) => {
                this.logger.warn(`HueAdapter: Poll error: ${err.message}`);
            });
        }, 5000);

        this.logger.info('HueAdapter: Initialized');
    }

    /**
     * Execute an MQTT command (setLight, scene, etc.).
     */
    async executeCommand(payload) {
        this._assertNotDisposed();

        if (!payload || typeof payload !== 'object') {
            this.publishWarning('HUE_CMD_INVALID', 'Command payload must be a JSON object');
            return;
        }

        const action = payload.action || payload.command;

        try {
            switch (action) {
                case 'setLight':
                    await this._setLight(payload);
                    break;
                case 'setScene':
                    await this._setScene(payload);
                    break;
                case 'allOn':
                    await this._allOn();
                    break;
                case 'allOff':
                    await this._allOff();
                    break;
                default:
                    this.publishWarning('HUE_CMD_UNKNOWN', `Unknown action: ${action}`);
            }
        } catch (err) {
            this.publishWarning('HUE_CMD_FAILED', `Command failed: ${err.message}`, { action });
        }
    }

    /**
     * Handle state updates (called by PxB when upstream state changes).
     * For Hue, state is typically driven by API calls, not upstream events.
     */
    handleStateUpdate(state) {
        // Hue is generally command-driven, not event-driven from radio nodes.
        // If needed for future use cases (e.g., scene based on room state).
    }

    /**
     * Shut down: stop polling, unsubscribe.
     */
    async dispose() {
        this._assertNotDisposed();

        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }

        if (this._subscribed) {
            const commandTopic = `${this.config.topic}/commands`;
            this.mqttClient.unsubscribe(commandTopic).catch((err) => {
                this.logger.warn(`HueAdapter: Unsubscribe error: ${err.message}`);
            });
            this._subscribed = false;
        }

        this._markDisposed();
        this.logger.info('HueAdapter: Disposed');
    }

    // ---- Private Methods ----

    /**
     * Fetch all lights from Hue Bridge.
     */
    async _fetchLights() {
        const url = `http://${this.host}:${this.port}/api/${this.apiKey}/lights`;
        const response = await this._httpGet(url);
        return response;
    }

    /**
     * Set a single light's state.
     * Payload: { lightId: '1', on: true, brightness: 200, hue: 10000, sat: 254, ... }
     */
    async _setLight(payload) {
        const { lightId, on, brightness, hue, sat, ct, transitiontime } = payload;

        if (!lightId) {
            this.publishWarning('HUE_SETLIGHT_MISSING_ID', 'lightId is required');
            return;
        }

        const state = {};
        if (on !== undefined) state.on = Boolean(on);
        if (brightness !== undefined) state.bri = Math.max(0, Math.min(254, brightness));
        if (hue !== undefined) state.hue = hue;
        if (sat !== undefined) state.sat = sat;
        if (ct !== undefined) state.ct = ct;
        if (transitiontime !== undefined) state.transitiontime = transitiontime;

        const url = `http://${this.host}:${this.port}/api/${this.apiKey}/lights/${lightId}/state`;
        const response = await this._httpPut(url, state);

        // Verify success
        if (response && Array.isArray(response) && response[0].success) {
            this.publishEvent('light-updated', { lightId, state });
            this.logger.info(`HueAdapter: Light ${lightId} updated`);
            // Refresh state
            await this._pollState();
        } else {
            throw new Error(`Hue API error: ${JSON.stringify(response)}`);
        }
    }

    /**
     * Recall a scene (simplified: in real Hue API, scenes are complex).
     * Payload: { sceneId: '1', transition: 500 }
     */
    async _setScene(payload) {
        const { sceneId, transition } = payload;

        if (!sceneId) {
            this.publishWarning('HUE_SCENE_MISSING_ID', 'sceneId is required');
            return;
        }

        // Hue scene recall is typically via /groups/0/action endpoint
        const state = { scene: sceneId };
        if (transition) state.transition = transition;

        const url = `http://${this.host}:${this.port}/api/${this.apiKey}/groups/0/action`;
        const response = await this._httpPut(url, state);

        if (response && Array.isArray(response) && response[0].success) {
            this.publishEvent('scene-activated', { sceneId });
            this.logger.info(`HueAdapter: Scene ${sceneId} activated`);
            await this._pollState();
        } else {
            throw new Error(`Hue scene error: ${JSON.stringify(response)}`);
        }
    }

    /**
     * Turn all lights on.
     */
    async _allOn() {
        const url = `http://${this.host}:${this.port}/api/${this.apiKey}/groups/0/action`;
        const response = await this._httpPut(url, { on: true });

        if (response && Array.isArray(response) && response[0].success) {
            this.publishEvent('all-on');
            await this._pollState();
        } else {
            throw new Error(`Hue allOn error: ${JSON.stringify(response)}`);
        }
    }

    /**
     * Turn all lights off.
     */
    async _allOff() {
        const url = `http://${this.host}:${this.port}/api/${this.apiKey}/groups/0/action`;
        const response = await this._httpPut(url, { on: false });

        if (response && Array.isArray(response) && response[0].success) {
            this.publishEvent('all-off');
            await this._pollState();
        } else {
            throw new Error(`Hue allOff error: ${JSON.stringify(response)}`);
        }
    }

    /**
     * Poll for state updates from Hue Bridge.
     */
    async _pollState() {
        try {
            const lights = await this._fetchLights();
            for (const [lightId, lightState] of Object.entries(lights)) {
                this.lights.set(lightId, lightState);
            }
            this._publishState();
        } catch (err) {
            this.logger.warn(`HueAdapter: Poll failed: ${err.message}`);
        }
    }

    /**
     * Publish current state to MQTT.
     */
    _publishState() {
        const lights = {};
        for (const [id, state] of this.lights) {
            lights[id] = {
                on: state.state?.on || false,
                brightness: state.state?.bri || 0,
                reachable: state.state?.reachable !== false,
            };
        }

        this.publishState({
            type: 'hue',
            timestamp: new Date().toISOString(),
            connected: true,
            lights,
        });
    }

    /**
     * Handle inbound MQTT command message.
     */
    async _handleCommand(msg) {
        try {
            const payload = JSON.parse(msg);
            await this.executeCommand(payload);
        } catch (err) {
            this.logger.error(`HueAdapter: Failed to parse command: ${err.message}`);
        }
    }

    // ---- HTTP Helpers ----

    /**
     * HTTP GET request.
     */
    async _httpGet(url) {
        return new Promise((resolve, reject) => {
            const http = require('http');
            const req = http
                .get(url, { timeout: this.timeoutMs }, (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (err) {
                            reject(new Error(`Invalid JSON response: ${err.message}`));
                        }
                    });
                })
                .on('error', reject)
                .on('timeout', () => {
                    req.destroy();
                    reject(new Error(`HTTP timeout (${this.timeoutMs}ms)`));
                });
        });
    }

    /**
     * HTTP PUT request.
     */
    async _httpPut(url, body) {
        return new Promise((resolve, reject) => {
            const http = require('http');
            const data = JSON.stringify(body);

            const urlObj = new URL(url);
            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || 80,
                path: urlObj.pathname + urlObj.search,
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                },
                timeout: this.timeoutMs,
            };

            const req = http
                .request(options, (res) => {
                    let respData = '';
                    res.on('data', (chunk) => {
                        respData += chunk;
                    });
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(respData));
                        } catch (err) {
                            reject(new Error(`Invalid JSON response: ${err.message}`));
                        }
                    });
                })
                .on('error', reject)
                .on('timeout', () => {
                    req.destroy();
                    reject(new Error(`HTTP timeout (${this.timeoutMs}ms)`));
                });

            req.write(data);
            req.end();
        });
    }
}

module.exports = HueAdapter;
