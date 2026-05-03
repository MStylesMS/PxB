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

// Tuned cross-device color scenes migrated from PFx (pre-extraction).
const LIFX_COLOR_SCENES = {
    normal:      { on: true, kelvin: 4000,            brightness: 80  },
    dim:         { on: true, kelvin: 4000,            brightness: 35  },
    red:         { on: true, r: 255, g: 0,   b: 0,   brightness: 80  },
    blue:        { on: true, r: 0,   g: 70,  b: 255, brightness: 75  },
    green:       { on: true, r: 0,   g: 255, b: 90,  brightness: 75  },
    yellow:      { on: true, r: 255, g: 220, b: 0,   brightness: 80  },
    orange:      { on: true, r: 255, g: 110, b: 0,   brightness: 80  },
    purple:      { on: true, r: 170, g: 60,  b: 255, brightness: 75  },
    pink:        { on: true, r: 255, g: 105, b: 180, brightness: 75  },
    cyan:        { on: true, r: 0,   g: 220, b: 255, brightness: 75  },
    magenta:     { on: true, r: 255, g: 0,   b: 200, brightness: 75  },
    white:       { on: true, kelvin: 4000,            brightness: 75  },
    softWhite:   { on: true, kelvin: 2700,            brightness: 70  },
    brightWhite: { on: true, kelvin: 6500,            brightness: 100 },
    warmWhite:   { on: true, kelvin: 2200,            brightness: 80  },
    coolWhite:   { on: true, kelvin: 6000,            brightness: 85  },
    off:         { on: false },
};

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
        this.sceneMap = {
            ...LIFX_COLOR_SCENES,
            ...this._parseSceneMap(config.scene_map),
        };
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
                case 'scene':
                    await this._applyColorScene(payload.scene || payload.name);
                    break;
                case 'setLight': await this._setLight(payload); break;
                case 'setScene':
                case 'setColorScene': await this._applyColorScene(payload.scene || payload.name); break;
                case 'on':
                case 'allOn':   await this._setState({ power: 'on' }); this.publishEvent('all-on'); break;
                case 'off':
                case 'allOff':  await this._setState({ power: 'off' }); this.publishEvent('all-off'); break;
                case 'setBrightness':
                    await this._setBrightness(payload);
                    break;
                case 'setColor':
                    await this._setColor(payload);
                    break;
                case 'setColorTemp':
                    await this._setColorTemp(payload);
                    break;
                case 'fade':
                    await this._fade(payload);
                    break;
                case 'getStatus':
                case 'getState':
                    await this._pollState();
                    break;
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

    async _setBrightness(payload) {
        const bri = this._clampBrightness(payload.brightness);
        await this._setState({
            power: bri > 0 ? 'on' : 'off',
            brightness: Math.max(0, Math.min(1, bri / 100)),
        });
        this.publishEvent('brightness-updated', { brightness: bri });
    }

    async _setColor(payload) {
        const rgb = this._parseColor(payload.color);
        const body = {
            power: 'on',
            color: `rgb:${rgb.r},${rgb.g},${rgb.b}`,
        };
        if (payload.brightness !== undefined) {
            body.brightness = Math.max(0, Math.min(1, this._clampBrightness(payload.brightness) / 100));
        }
        await this._setState(body);
        this.publishEvent('color-updated', { color: payload.color });
    }

    async _setColorTemp(payload) {
        const kelvin = Math.max(1500, Math.min(9000, Number.parseInt(payload.kelvin, 10) || 3500));
        await this._setState({
            power: 'on',
            kelvin,
            brightness: Math.max(0, Math.min(1, this._clampBrightness(payload.brightness ?? 100) / 100)),
        });
        this.publishEvent('color-temperature-updated', { kelvin });
    }

    async _fade(payload) {
        const bri = this._clampBrightness(payload.brightness);
        const duration = Math.max(0, Number.parseFloat(payload.duration ?? payload.duration_s ?? 0) || 0);
        await this._setState({
            power: bri > 0 ? 'on' : 'off',
            brightness: Math.max(0, Math.min(1, bri / 100)),
            duration,
        });
    }

    async _applyColorScene(sceneName) {
        if (!sceneName) {
            this.publishWarning('LIFX_SCENE_MISSING_NAME', 'scene name is required');
            return;
        }

        const scene = this.sceneMap[sceneName]
            ?? this.sceneMap[Object.keys(this.sceneMap).find((k) => k.toLowerCase() === sceneName.toLowerCase())];
        if (!scene) {
            this.publishWarning('LIFX_SCENE_UNKNOWN', `Unknown scene '${sceneName}'`);
            return;
        }

        if (scene.on === false) {
            await this._setState({ power: 'off' });
            this.publishEvent('scene-activated', { scene: sceneName });
            return;
        }

        const body = { power: 'on' };
        if (scene.brightness !== undefined) {
            body.brightness = Math.max(0, Math.min(1, scene.brightness / 100));
        }
        if (scene.r !== undefined && scene.g !== undefined && scene.b !== undefined) {
            body.color = `rgb:${scene.r},${scene.g},${scene.b}`;
        } else if (scene.kelvin !== undefined) {
            body.kelvin = scene.kelvin;
        }

        await this._setState(body);
        this.publishEvent('scene-activated', { scene: sceneName });
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

    _parseSceneMap(raw) {
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                this.logger.warn('LifxAdapter: scene_map must be a JSON object; ignoring');
                return {};
            }
            return parsed;
        } catch (err) {
            this.logger.warn(`LifxAdapter: Failed to parse scene_map JSON: ${err.message}`);
            return {};
        }
    }

    _clampBrightness(value) {
        const n = Number.parseInt(value, 10);
        if (Number.isNaN(n)) return 100;
        return Math.max(0, Math.min(100, n));
    }

    _parseColor(color) {
        if (!color || typeof color !== 'string') {
            return { r: 255, g: 255, b: 255 };
        }
        const hex = color.trim().replace('#', '');
        if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
            throw new Error(`Invalid color '${color}', expected #RRGGBB`);
        }
        return {
            r: Number.parseInt(hex.slice(0, 2), 16),
            g: Number.parseInt(hex.slice(2, 4), 16),
            b: Number.parseInt(hex.slice(4, 6), 16),
        };
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
