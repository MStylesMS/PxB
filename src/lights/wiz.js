/**
 * src/lights/wiz.js — WiZ light adapter for PxB
 *
 * Manages WiZ smart light control via UDP LAN protocol.
 * Each WiZ device listens on port 38899 (UDP); commands are JSON pilotAction messages.
 *
 * Protocol reference: https://github.com/sbidy/pywizlight/blob/master/PROTOCOL.md
 */

'use strict';

const dgram = require('dgram');
const AdapterBase = require('../adapter-base');

const WIZ_UDP_PORT = 38899;

/**
 * Named color scenes. Each entry maps directly to a WiZ setPilot payload.
 * Names match the Hue backend for cross-backend compatibility.
 */
const WIZ_COLOR_SCENES = {
    normal:      { state: true,  temp: 4000, dimming: 80  },
    dim:         { state: true,  temp: 4000, dimming: 35  },
    red:         { state: true,  r: 255, g: 0,   b: 0,   dimming: 80 },
    blue:        { state: true,  r: 0,   g: 0,   b: 255, dimming: 75 },
    green:       { state: true,  r: 0,   g: 255, b: 0,   dimming: 75 },
    yellow:      { state: true,  r: 255, g: 220, b: 0,   dimming: 80 },
    orange:      { state: true,  r: 255, g: 90,  b: 0,   dimming: 80 },
    purple:      { state: true,  r: 170, g: 60,  b: 255, dimming: 75 },
    pink:        { state: true,  r: 255, g: 105, b: 180, dimming: 75 },
    cyan:        { state: true,  r: 0,   g: 220, b: 255, dimming: 75 },
    magenta:     { state: true,  r: 255, g: 0,   b: 200, dimming: 75 },
    white:       { state: true,  temp: 4000, dimming: 75  },
    softWhite:   { state: true,  temp: 2700, dimming: 70  },
    brightWhite: { state: true,  temp: 6500, dimming: 100 },
    warmWhite:   { state: true,  temp: 2200, dimming: 80  },
    coolWhite:   { state: true,  temp: 6000, dimming: 85  },
    off:         { state: false },
};

/**
 * WizAdapter — Controls WiZ lights via UDP LAN protocol.
 *
 * Config keys expected:
 *   - topic: MQTT topic for this zone
 *   - host: WiZ device IP address (e.g., '192.168.1.120'); required
 *   - port: UDP port (optional, default 38899)
 *   - brightness: Default brightness 0–255 (optional, default 100 = scaled to 100%)
 *   - timeout_s: UDP response timeout (optional, default 5)
 */
class WizAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger }) {
        super({ name: 'WizAdapter', config, mqttClient, logger });

        this.host = config.host;
        this.port = config.port || WIZ_UDP_PORT;
        this.brightness = Math.round((config.brightness || 100) * 2.55); // scale 0-100 → 0-255
        this.timeoutMs = (config.timeout_s || 5) * 1000;
        this.sceneMap = {
            ...WIZ_COLOR_SCENES,
            ...this._parseSceneMap(config.scene_map),
        };

        if (!this.host) {
            throw new Error('WizAdapter: config.host is required');
        }

        this.state = { on: false, brightness: 0, sceneId: 0 };
        this.updateTimer = null;
        this._subscribed = false;
        this._socket = null;
        this._pollFailCount = 0;
        this._connectivity = 'online'; // 'online' | 'degraded'
    }

    async init() {
        this._assertNotDisposed();
        this.logger.info(`WizAdapter: Initializing (device: ${this.host}:${this.port})`);

        try {
            const state = await this._fetchState();
            this.state = state;
        } catch (err) {
            this.publishWarning('WIZ_INIT_FAILED', `Failed to fetch state: ${err.message}`);
            throw err;
        }

        const commandTopic = `${this.config.topic}/commands`;
        this.mqttClient.subscribe(commandTopic, (msg) => {
            this._handleCommand(msg).catch((err) => {
                this.logger.error(`WizAdapter: Command handler error: ${err.message}`);
            });
        });
        this._subscribed = true;

        this._publishState();

        this.updateTimer = setInterval(() => {
            this._fetchState().then((s) => {
                this.state = s;
                if (this._connectivity !== 'online') {
                    this._connectivity = 'online';
                    this._pollFailCount = 0;
                    this.logger.info(`WizAdapter: ${this.host} recovered`);
                }
                this._publishState();
            }).catch((err) => {
                this._pollFailCount++;
                this.logger.warn(`WizAdapter: Poll failed (${this._pollFailCount}): ${err.message}`);
                if (this._pollFailCount >= 3 && this._connectivity !== 'degraded') {
                    this._connectivity = 'degraded';
                    this._publishDegraded(err.message);
                }
            });
        }, 5000);

        this.logger.info('WizAdapter: Initialized');
    }

    async executeCommand(payload) {
        this._assertNotDisposed();
        if (!payload || typeof payload !== 'object') {
            this.publishWarning('WIZ_CMD_INVALID', 'Command payload must be a JSON object');
            return;
        }

        const action = payload.action || payload.command;
        try {
            switch (action) {
                case 'scene':
                    await this._applyColorScene(payload.scene || payload.name);
                    break;
                case 'setLight': await this._setLight(payload); break;
                case 'on':
                case 'allOn':   await this._send({ method: 'setPilot', params: { state: true, dimming: 100 } }); this.publishEvent('all-on'); break;
                case 'off':
                case 'allOff':  await this._send({ method: 'setPilot', params: { state: false } }); this.publishEvent('all-off'); break;
                case 'setScene': await this._setScene(payload); break;
                case 'setColorScene': await this._applyColorScene(payload.scene || payload.name); break;
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
                    this.state = await this._fetchState();
                    break;
                default:
                    this.publishWarning('WIZ_CMD_UNKNOWN', `Unknown action: ${action}`);
            }
            // Refresh state after command
            this.state = await this._fetchState();
            this._publishState();
        } catch (err) {
            this.publishWarning('WIZ_CMD_FAILED', `Command failed: ${err.message}`, { action });
        }
    }

    handleStateUpdate(_state) {
        // WiZ is command-driven; no upstream radio state integration needed.
    }

    async dispose() {
        this._assertNotDisposed();

        if (this.updateTimer) { clearInterval(this.updateTimer); this.updateTimer = null; }

        if (this._subscribed) {
            this.mqttClient.unsubscribe(`${this.config.topic}/commands`).catch((err) => {
                this.logger.warn(`WizAdapter: Unsubscribe error: ${err.message}`);
            });
            this._subscribed = false;
        }

        if (this._socket) { this._socket.close(); this._socket = null; }

        this._markDisposed();
        this.logger.info('WizAdapter: Disposed');
    }

    // ---- Private Methods ----

    async _setLight(payload) {
        const params = {};
        if (payload.on !== undefined) params.state = Boolean(payload.on);
        if (payload.brightness !== undefined) params.dimming = Math.max(10, Math.min(100, payload.brightness));
        if (payload.speed !== undefined) params.speed = payload.speed;
        await this._send({ method: 'setPilot', params });
        this.publishEvent('light-updated', params);
    }

    async _setScene(payload) {
        const { sceneId } = payload;
        if (!sceneId) { this.publishWarning('WIZ_SCENE_MISSING_ID', 'sceneId is required'); return; }
        await this._send({ method: 'setPilot', params: { schdPsetId: sceneId } });
        this.publishEvent('scene-activated', { sceneId });
    }

    async _setBrightness(payload) {
        const dimming = this._clampBrightness(payload.brightness);
        await this._send({ method: 'setPilot', params: { state: dimming > 0, dimming } });
        this.publishEvent('brightness-updated', { brightness: dimming });
    }

    async _setColor(payload) {
        const rgb = this._parseColor(payload.color);
        await this._send({
            method: 'setPilot',
            params: {
                state: true,
                dimming: this._clampBrightness(payload.brightness ?? 100),
                r: this._clampChannel(rgb.r),
                g: this._clampChannel(rgb.g),
                b: this._clampChannel(rgb.b),
            },
        });
        this.publishEvent('color-updated', { color: payload.color });
    }

    async _setColorTemp(payload) {
        const temp = Math.max(2200, Math.min(6500, Number.parseInt(payload.kelvin, 10) || 4000));
        await this._send({
            method: 'setPilot',
            params: {
                state: true,
                temp,
                dimming: this._clampBrightness(payload.brightness ?? 100),
            },
        });
        this.publishEvent('color-temperature-updated', { kelvin: temp });
    }

    async _fade(payload) {
        const dimming = this._clampBrightness(payload.brightness);
        await this._send({ method: 'setPilot', params: { state: dimming > 0, dimming } });
        this.publishWarning('WIZ_CMD_LIMITATION', 'WiZ fade duration is not natively supported; applied immediate level change');
    }

    async _applyColorScene(sceneName) {
        if (!sceneName) { this.publishWarning('WIZ_SCENE_MISSING_NAME', 'scene name is required'); return; }
        const scene = this.sceneMap[sceneName]
            ?? this.sceneMap[Object.keys(this.sceneMap).find((k) => k.toLowerCase() === sceneName.toLowerCase())];
        if (!scene) { this.publishWarning('WIZ_SCENE_UNKNOWN', `Unknown scene '${sceneName}'`); return; }
        await this._send({ method: 'setPilot', params: scene });
        this.publishEvent('scene-activated', { scene: sceneName });
    }

    async _fetchState() {
        const resp = await this._send({ method: 'getPilot', params: {} });
        const r = resp && resp.result;
        return {
            on: r ? r.state === true : false,
            brightness: r ? Math.round((r.dimming || 0)) : 0,
            sceneId: r ? (r.schdPsetId || 0) : 0,
        };
    }

    _publishState() {
        this.publishState({
            type: 'wiz',
            status: 'online',
            host: this.host,
            timestamp: new Date().toISOString(),
            ...this.state,
        });
    }

    _publishDegraded(reason) {
        this.publishWarning('WIZ_DEVICE_UNREACHABLE', `Device at ${this.host} is not responding: ${reason}`);
        this.publishState({
            type: 'wiz',
            status: 'degraded',
            host: this.host,
            reason,
            timestamp: new Date().toISOString(),
        });
    }

    async _handleCommand(msg) {
        try { await this.executeCommand(JSON.parse(msg)); }
        catch (err) { this.logger.error(`WizAdapter: Failed to parse command: ${err.message}`); }
    }

    _parseSceneMap(raw) {
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                this.logger.warn('WizAdapter: scene_map must be a JSON object; ignoring');
                return {};
            }
            return parsed;
        } catch (err) {
            this.logger.warn(`WizAdapter: Failed to parse scene_map JSON: ${err.message}`);
            return {};
        }
    }

    _clampBrightness(value) {
        const numeric = Number.parseInt(value, 10);
        if (Number.isNaN(numeric)) return 100;
        return Math.max(0, Math.min(100, numeric));
    }

    _clampChannel(value) {
        const n = Number.parseInt(value, 10);
        if (Number.isNaN(n)) return 0;
        return Math.max(0, Math.min(255, n));
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

    /**
     * Send a JSON UDP message and await the response.
     */
    _send(message) {
        return new Promise((resolve, reject) => {
            const socket = dgram.createSocket('udp4');
            const data = Buffer.from(JSON.stringify(message));

            const timer = setTimeout(() => {
                socket.close();
                reject(new Error(`UDP timeout (${this.timeoutMs}ms) sending to ${this.host}:${this.port}`));
            }, this.timeoutMs);

            socket.on('message', (msg) => {
                clearTimeout(timer);
                socket.close();
                try { resolve(JSON.parse(msg.toString())); }
                catch (e) { reject(new Error(`Invalid UDP response: ${e.message}`)); }
            });

            socket.on('error', (err) => {
                clearTimeout(timer);
                socket.close();
                reject(err);
            });

            socket.send(data, this.port, this.host, (err) => {
                if (err) { clearTimeout(timer); socket.close(); reject(err); }
            });
        });
    }
}

module.exports = WizAdapter;
