/**
 * src/switches/shelly.js — Shelly smart switch/relay adapter for PxB
 *
 * Manages Shelly smart switches and relays via the local REST API.
 * Supports Gen1 (Shelly 1, 2, 1PM, 2.5, EM) and Gen2/Plus devices.
 *
 * Gen1 API: http://{host}/relay/{channel}  POST/GET
 * Gen2 API: http://{host}/rpc/Switch.Set   POST JSON-RPC
 */

'use strict';

const http = require('http');
const AdapterBase = require('../adapter-base');

/**
 * ShellyAdapter — Controls Shelly devices via local HTTP REST API.
 *
 * Config keys expected:
 *   - topic: MQTT topic for this zone
 *   - host: Shelly device IP address (e.g., '192.168.1.110'); required
 *   - port: HTTP port (optional, default 80)
 *   - gen: API generation (optional, 1 or 2; default auto-detect)
 *   - channel: Default channel/relay index (optional, default 0)
 *   - timeout_s: HTTP request timeout (optional, default 5)
 */
class ShellyAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger }) {
        super({ name: 'ShellyAdapter', config, mqttClient, logger });

        this.host = config.host;
        this.port = config.port || 80;
        this.gen = config.gen || null;    // null = auto-detect
        this.channel = config.channel || 0;
        this.timeoutMs = (config.timeout_s || 5) * 1000;

        if (!this.host) {
            throw new Error('ShellyAdapter: config.host is required');
        }

        this.relays = [];            // Array of { id, on, overpower, ... }
        this.deviceInfo = null;      // { type, mac, fw_ver, ... }
        this.updateTimer = null;
        this._subscribed = false;
    }

    async init() {
        this._assertNotDisposed();
        this.logger.info(`ShellyAdapter: Initializing (device: ${this.host}:${this.port})`);

        try {
            this.deviceInfo = await this._fetchDeviceInfo();
            if (!this.gen) {
                // Auto-detect: Gen2+ devices have /rpc/Shelly.GetStatus
                this.gen = this.deviceInfo._gen || 1;
            }
            this.logger.info(`ShellyAdapter: Device=${this.deviceInfo.type || 'unknown'} gen=${this.gen}`);

            this.relays = await this._fetchRelayStatus();
        } catch (err) {
            this.publishWarning('SHELLY_INIT_FAILED', `Init failed: ${err.message}`);
            throw err;
        }

        const commandTopic = `${this.config.topic}/commands`;
        this.mqttClient.subscribe(commandTopic, (msg) =>
            this.safeCall('command', () => this._handleCommand(msg)));
        this._subscribed = true;

        this._publishState();

        // eslint-disable-next-line no-restricted-syntax -- safeCall wraps this callback
        this.updateTimer = setInterval(() => this.safeCall('poll', async () => {
            try {
                const relays = await this._fetchRelayStatus();
                this.relays = relays;
                this._publishState();
            } catch (err) {
                this.logger.warn(`ShellyAdapter: Poll failed: ${err.message}`);
            }
        }), 5000);

        this.logger.info('ShellyAdapter: Initialized');
    }

    async executeCommand(payload) {
        this._assertNotDisposed();
        if (!payload || typeof payload !== 'object') {
            this.publishWarning('SHELLY_CMD_INVALID', 'Command payload must be a JSON object');
            return;
        }

        const action = payload.action || payload.command;
        try {
            switch (action) {
                case 'setRelay':  await this._setRelay(payload); break;
                case 'pulse':     await this._pulse(payload); break;
                case 'allOn':     await this._setAllRelays(true); break;
                case 'allOff':    await this._setAllRelays(false); break;
                default:
                    this.publishWarning('SHELLY_CMD_UNKNOWN', `Unknown action: ${action}`);
                    return;
            }
            this.relays = await this._fetchRelayStatus();
            this._publishState();
        } catch (err) {
            this.publishWarning('SHELLY_CMD_FAILED', `Command failed: ${err.message}`, { action });
        }
    }

    handleStateUpdate(_state) {
        // Shelly is command-driven; no upstream radio state integration needed.
    }

    async dispose() {
        this._assertNotDisposed();

        if (this.updateTimer) { clearInterval(this.updateTimer); this.updateTimer = null; }

        if (this._subscribed) {
            this.mqttClient.unsubscribe(`${this.config.topic}/commands`).catch((err) => {
                this.logger.warn(`ShellyAdapter: Unsubscribe error: ${err.message}`);
            });
            this._subscribed = false;
        }

        this._markDisposed();
        this.logger.info('ShellyAdapter: Disposed');
    }

    // ---- Private Methods ----

    async _setRelay(payload) {
        const channel = payload.channel !== undefined ? payload.channel : this.channel;
        const on = Boolean(payload.on);
        await this._relayAction(channel, on ? 'on' : 'off');
        this.publishEvent('relay-set', { channel, on });
    }

    async _pulse(payload) {
        const channel = payload.channel !== undefined ? payload.channel : this.channel;
        const durationMs = payload.duration_ms || 500;
        await this._relayAction(channel, 'on');
        // eslint-disable-next-line no-restricted-syntax -- promise-wrapping delay, errors propagate through executeCommand
        await new Promise((r) => setTimeout(r, durationMs));
        await this._relayAction(channel, 'off');
        this.publishEvent('relay-pulsed', { channel, duration_ms: durationMs });
    }

    async _setAllRelays(on) {
        const actions = this.relays.map((_, i) => this._relayAction(i, on ? 'on' : 'off'));
        await Promise.all(actions);
        this.publishEvent(on ? 'all-on' : 'all-off');
    }

    async _relayAction(channel, turn) {
        if (this.gen === 2) {
            await this._httpPost('/rpc/Switch.Set', { id: channel, on: turn === 'on' });
        } else {
            await this._httpGet(`/relay/${channel}?turn=${turn}`);
        }
    }

    async _fetchDeviceInfo() {
        try {
            // Try Gen2 first
            const info = await this._httpGet('/rpc/Shelly.GetDeviceInfo');
            info._gen = 2;
            return info;
        } catch {
            // Fall back to Gen1
            const info = await this._httpGet('/shelly');
            info._gen = 1;
            return info;
        }
    }

    async _fetchRelayStatus() {
        if (this.gen === 2) {
            // Gen2: /rpc/Switch.GetStatus returns single channel; iterate
            const statuses = [];
            for (let i = 0; i <= this.channel; i++) {
                try {
                    const s = await this._httpPost('/rpc/Switch.GetStatus', { id: i });
                    statuses.push({ id: i, on: s.output === true });
                } catch { break; }
            }
            return statuses;
        } else {
            // Gen1: /relay/0 returns all relay states
            try {
                const status = await this._httpGet('/status');
                return (status.relays || []).map((r, i) => ({ id: i, on: r.ison === true }));
            } catch {
                return [{ id: 0, on: false }];
            }
        }
    }

    _relayStateToken() {
        const first = Array.isArray(this.relays) && this.relays[0];
        return first && first.on === true ? 'on' : 'off';
    }

    _publishState() {
        this.publishState({
            type: 'shelly',
            host: this.host,
            gen: this.gen || 1,
            timestamp: new Date().toISOString(),
            state: this._relayStateToken(),
            relays: this.relays,
        });
    }

    async _handleCommand(msg) {
        try { await this.executeCommand(JSON.parse(msg)); }
        catch (err) { this.logger.error(`ShellyAdapter: Failed to parse command: ${err.message}`); }
    }

    async _httpGet(path) {
        return this._httpRequest('GET', path, null);
    }

    async _httpPost(path, body) {
        return this._httpRequest('POST', path, body);
    }

    async _httpRequest(method, path, body) {
        return new Promise((resolve, reject) => {
            const data = body ? JSON.stringify(body) : null;
            const options = {
                hostname: this.host,
                port: this.port,
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
                },
                timeout: this.timeoutMs,
            };

            const req = http.request(options, (res) => {
                let respData = '';
                res.on('data', (chunk) => { respData += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(respData)); }
                    catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error(`HTTP timeout (${this.timeoutMs}ms)`)); });
            if (data) req.write(data);
            req.end();
        });
    }
}

module.exports = ShellyAdapter;
