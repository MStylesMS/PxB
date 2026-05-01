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

        if (!this.host) {
            throw new Error('WizAdapter: config.host is required');
        }

        this.state = { on: false, brightness: 0, sceneId: 0 };
        this.updateTimer = null;
        this._subscribed = false;
        this._socket = null;
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
                this._publishState();
            }).catch((err) => {
                this.logger.warn(`WizAdapter: Poll failed: ${err.message}`);
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
                case 'setLight': await this._setLight(payload); break;
                case 'allOn':   await this._send({ method: 'setPilot', params: { state: true, dimming: 100 } }); this.publishEvent('all-on'); break;
                case 'allOff':  await this._send({ method: 'setPilot', params: { state: false } }); this.publishEvent('all-off'); break;
                case 'setScene': await this._setScene(payload); break;
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

    handleStateUpdate(state) {
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
            host: this.host,
            timestamp: new Date().toISOString(),
            ...this.state,
        });
    }

    async _handleCommand(msg) {
        try { await this.executeCommand(JSON.parse(msg)); }
        catch (err) { this.logger.error(`WizAdapter: Failed to parse command: ${err.message}`); }
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
