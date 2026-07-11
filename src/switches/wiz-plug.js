/**
 * src/switches/wiz-plug.js — WiZ smart plug/socket adapter for PxB
 *
 * WiZ smart plugs are single-channel on/off devices (no dimming/color). They
 * speak the same WiZ UDP LAN protocol as WiZ bulbs on port 38899, but are
 * relay-oriented, so they belong in the switch domain alongside Shelly.
 *
 * On/off is driven with the `setState` method (side-effect free, unlike
 * `setPilot` which mimics remote-control behaviour); status is read with
 * `getPilot`.
 *
 * Protocol reference: https://github.com/sbidy/pywizlight/blob/master/PROTOCOL.md
 */

'use strict';

const dgram = require('dgram');
const AdapterBase = require('../adapter-base');

const WIZ_UDP_PORT = 38899;

/**
 * WizPlugAdapter — Controls WiZ smart plugs via UDP LAN protocol.
 *
 * Config keys expected:
 *   - topic: MQTT topic for this switch (required)
 *   - host: WiZ plug IP address (e.g., '192.168.1.130'); required
 *   - port: UDP port (optional, default 38899)
 *   - timeout_s: UDP response timeout (optional, default 5)
 *
 * WiZ plugs are single-channel, so relay channel is always 0. The switch
 * command vocabulary (setRelay / pulse / allOn / allOff) matches the Shelly
 * backend so downstream consumers can treat both identically.
 */
class WizPlugAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger }) {
        super({ name: 'WizPlugAdapter', config, mqttClient, logger });

        this.host = config.host;
        this.port = config.port || WIZ_UDP_PORT;
        this.timeoutMs = (config.timeout_s || 5) * 1000;

        if (!this.host) {
            throw new Error('WizPlugAdapter: config.host is required');
        }

        this.relays = [{ id: 0, on: false }];
        this.updateTimer = null;
        this._subscribed = false;
        this._pollFailCount = 0;
        this._connectivity = 'online'; // 'online' | 'degraded'
    }

    async init() {
        this._assertNotDisposed();
        this.logger.info(`WizPlugAdapter: Initializing (device: ${this.host}:${this.port})`);

        try {
            this.relays = await this._fetchRelayStatus();
        } catch (err) {
            this.publishWarning('WIZ_PLUG_INIT_FAILED', `Failed to fetch state: ${err.message}`);
            throw err;
        }

        const commandTopic = `${this.config.topic}/commands`;
        this.mqttClient.subscribe(commandTopic, (_topic, payload) =>
            this.safeCall('command', () => this._handleCommand(payload)));
        this._subscribed = true;

        this._publishState();

        // eslint-disable-next-line no-restricted-syntax -- safeCall wraps this callback
        this.updateTimer = setInterval(() => this.safeCall('poll', async () => {
            try {
                this.relays = await this._fetchRelayStatus();
                if (this._connectivity !== 'online') {
                    this._connectivity = 'online';
                    this._pollFailCount = 0;
                    this.logger.info(`WizPlugAdapter: ${this.host} recovered`);
                }
                this._publishState();
            } catch (err) {
                this._pollFailCount++;
                this.logger.warn(`WizPlugAdapter: Poll failed (${this._pollFailCount}): ${err.message}`);
                if (this._pollFailCount >= 3 && this._connectivity !== 'degraded') {
                    this._connectivity = 'degraded';
                    this._publishDegraded(err.message);
                }
            }
        }), 5000);

        this.logger.info('WizPlugAdapter: Initialized');
    }

    async executeCommand(payload) {
        this._assertNotDisposed();
        if (!payload || typeof payload !== 'object') {
            this.publishWarning('WIZ_PLUG_CMD_INVALID', 'Command payload must be a JSON object');
            return;
        }

        const action = payload.action || payload.command;
        try {
            switch (action) {
                case 'setRelay':  await this._setRelay(payload); break;
                case 'on':        await this._setState(true); this.publishEvent('relay-set', { channel: 0, on: true }); break;
                case 'off':       await this._setState(false); this.publishEvent('relay-set', { channel: 0, on: false }); break;
                case 'pulse':     await this._pulse(payload); break;
                case 'allOn':     await this._setState(true); this.publishEvent('all-on'); break;
                case 'allOff':    await this._setState(false); this.publishEvent('all-off'); break;
                default:
                    this.publishWarning('WIZ_PLUG_CMD_UNKNOWN', `Unknown action: ${action}`);
                    return;
            }
            this.relays = await this._fetchRelayStatus();
            this._publishState();
        } catch (err) {
            this.publishWarning('WIZ_PLUG_CMD_FAILED', `Command failed: ${err.message}`, { action });
        }
    }

    handleStateUpdate(_state) {
        // WiZ plug is command-driven; no upstream radio state integration needed.
    }

    async dispose() {
        this._assertNotDisposed();

        if (this.updateTimer) { clearInterval(this.updateTimer); this.updateTimer = null; }

        if (this._subscribed) {
            this.mqttClient.unsubscribe(`${this.config.topic}/commands`).catch((err) => {
                this.logger.warn(`WizPlugAdapter: Unsubscribe error: ${err.message}`);
            });
            this._subscribed = false;
        }

        this._markDisposed();
        this.logger.info('WizPlugAdapter: Disposed');
    }

    // ---- Private Methods ----

    async _setRelay(payload) {
        // WiZ plugs are single-channel; only channel 0 is meaningful.
        const channel = payload.channel !== undefined ? payload.channel : 0;
        if (channel !== 0) {
            this.publishWarning('WIZ_PLUG_CHANNEL_UNSUPPORTED',
                `WiZ plugs are single-channel; ignoring channel ${channel} and using 0`, { channel });
        }
        const on = Boolean(payload.on);
        await this._setState(on);
        this.publishEvent('relay-set', { channel: 0, on });
    }

    async _pulse(payload) {
        const durationMs = payload.duration_ms || 500;
        await this._setState(true);
        // eslint-disable-next-line no-restricted-syntax -- promise-wrapping delay, errors propagate through executeCommand
        await new Promise((r) => setTimeout(r, durationMs));
        await this._setState(false);
        this.publishEvent('relay-pulsed', { channel: 0, duration_ms: durationMs });
    }

    async _setState(on) {
        await this._send({ method: 'setState', params: { state: Boolean(on) } });
    }

    async _fetchRelayStatus() {
        const resp = await this._send({ method: 'getPilot', params: {} });
        const r = resp && resp.result;
        return [{ id: 0, on: r ? r.state === true : false }];
    }

    _publishState() {
        this.publishState({
            type: 'wiz-plug',
            status: this._connectivity === 'degraded' ? 'degraded' : 'online',
            host: this.host,
            timestamp: new Date().toISOString(),
            relays: this.relays,
        });
    }

    _publishDegraded(reason) {
        this.publishWarning('WIZ_PLUG_DEVICE_UNREACHABLE', `Device at ${this.host} is not responding: ${reason}`);
        this.publishState({
            type: 'wiz-plug',
            status: 'degraded',
            host: this.host,
            reason,
            timestamp: new Date().toISOString(),
            relays: this.relays,
        });
    }

    async _handleCommand(payload) {
        try { await this.executeCommand(typeof payload === 'string' ? JSON.parse(payload) : payload); }
        catch (err) { this.logger.error(`WizPlugAdapter: Failed to parse command: ${err.message}`); }
    }

    /**
     * Send a JSON UDP message and await the response.
     */
    _send(message) {
        return new Promise((resolve, reject) => {
            const socket = dgram.createSocket('udp4');
            const data = Buffer.from(JSON.stringify(message));

            // eslint-disable-next-line no-restricted-syntax -- internal UDP timeout, errors routed via reject
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

module.exports = WizPlugAdapter;
