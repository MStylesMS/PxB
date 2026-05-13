'use strict';

const AdapterBase = require('../adapter-base');

// ── Built-in fixture profiles ──────────────────────────────────────────────
// Each profile defines:
//   channels: ordered array of slot names, index = offset from DMX address (0-based)
//   capabilities: what command surface is available

const PROFILES = {
    dimmer: {
        channels:     ['dimmer'],
        capabilities: new Set(['dimmer']),
    },
    rgb: {
        channels:     ['red', 'green', 'blue'],
        capabilities: new Set(['dimmer', 'color']),
    },
};

// Phase 3 will move these into src/dmx/profiles/ and load them dynamically.
// The adapter accepts profile names that match PROFILES keys only.

// ── Default color scenes (shared across RGB-capable fixtures) ──────────────
const DEFAULT_SCENE_MAP = {
    normal:      { r: 255, g: 255, b: 255, brightness: 80 },
    dim:         { r: 255, g: 255, b: 255, brightness: 35 },
    red:         { r: 255, g: 0,   b: 0,   brightness: 80 },
    green:       { r: 0,   g: 255, b: 0,   brightness: 75 },
    blue:        { r: 0,   g: 0,   b: 255, brightness: 75 },
    yellow:      { r: 255, g: 220, b: 0,   brightness: 80 },
    orange:      { r: 255, g: 90,  b: 0,   brightness: 80 },
    purple:      { r: 170, g: 60,  b: 255, brightness: 75 },
    pink:        { r: 255, g: 105, b: 180, brightness: 75 },
    cyan:        { r: 0,   g: 220, b: 255, brightness: 75 },
    magenta:     { r: 255, g: 0,   b: 200, brightness: 75 },
    white:       { r: 255, g: 255, b: 255, brightness: 75 },
    softWhite:   { r: 255, g: 180, b: 100, brightness: 70 },
    brightWhite: { r: 255, g: 255, b: 255, brightness: 100 },
    warmWhite:   { r: 255, g: 147, b: 41,  brightness: 80 },
    coolWhite:   { r: 200, g: 220, b: 255, brightness: 85 },
    off:         { r: 0,   g: 0,   b: 0,   brightness: 0  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }

// Parse a color from the command payload.
// Accepts: { r, g, b }, CSS hex string "#rrggbb", or named scene (ignored here).
function parseColor(colorVal) {
    if (!colorVal) return null;
    if (typeof colorVal === 'object' && 'r' in colorVal) {
        return { r: clamp(colorVal.r ?? 0, 0, 255), g: clamp(colorVal.g ?? 0, 0, 255), b: clamp(colorVal.b ?? 0, 0, 255) };
    }
    if (typeof colorVal === 'string' && /^#?[0-9a-f]{6}$/i.test(colorVal.trim())) {
        const hex = colorVal.replace('#', '');
        return { r: parseInt(hex.slice(0,2), 16), g: parseInt(hex.slice(2,4), 16), b: parseInt(hex.slice(4,6), 16) };
    }
    return null;
}

/**
 * DmxAdapter — Controls a single DMX512 fixture through a shared DmxUniverse.
 *
 * Phase 2 built-in profiles: `dimmer` (1 ch), `rgb` (3 ch).
 *
 * Config keys:
 *   topic     — MQTT topic for this fixture
 *   fixture   — built-in profile name: 'dimmer' | 'rgb'
 *   address   — DMX start address, 1-based (default 1)
 *   brightness — default brightness 0–100 (default 100)
 *   scene_map — optional INI-encoded JSON overrides for colour scenes
 *
 * Unsupported commands: `fade`, `setColorTemp` — published as structured warnings,
 * never silently dropped. Documented in docs/MQTT_API.md §9a.
 */
class DmxAdapter extends AdapterBase {
    /**
     * @param {object}       opts
     * @param {object}       opts.config      — parsed INI section
     * @param {import('../mqtt/client').MqttClient} opts.mqttClient
     * @param {object}       opts.logger
     * @param {import('../dmx/universe').DmxUniverse} opts.universe — shared universe instance
     */
    constructor({ config, mqttClient, logger, universe }) {
        super({ name: 'DmxAdapter', config, mqttClient, logger });

        if (!universe) {
            throw new Error('DmxAdapter: universe is required (no [dmx] section configured or dmx disabled)');
        }

        const profileName = (config.fixture || '').toLowerCase();
        const profile = PROFILES[profileName];
        if (!profile) {
            throw new Error(
                `DmxAdapter: unknown fixture "${config.fixture}" — supported in Phase 2: ${Object.keys(PROFILES).join(', ')}`
            );
        }

        this._universe    = universe;
        this._profile     = profile;
        this._profileName = profileName;
        this._address     = clamp(config.address || 1, 1, 512);
        this._defaultBrightness = clamp(config.brightness || 100, 0, 100);

        // Verify the fixture fits within the universe
        const lastSlot = this._address + profile.channels.length - 1;
        if (lastSlot > 512) {
            throw new Error(
                `DmxAdapter: fixture "${config.fixture}" with ${profile.channels.length} channels starting at address ` +
                `${this._address} would end at slot ${lastSlot}, exceeding DMX 512-slot limit`
            );
        }

        this._sceneMap = { ...DEFAULT_SCENE_MAP, ...this._parseSceneMap(config.scene_map) };

        // Working state — reflects what was last pushed to the universe
        this._state = {
            on:         false,
            brightness: 0,
            color:      null,
            scene:      null,
        };

        this._subscribed = false;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    async init() {
        this._assertNotDisposed();
        this.logger.info(
            `DmxAdapter: Initializing (topic: ${this.config.topic}, fixture: ${this._profileName}, address: ${this._address})`
        );

        // Start blacked out
        this._applyBlackout();
        this._publishState();

        // Subscribe to commands
        await this.mqttClient.subscribe(`${this.config.topic}/commands`, (msg) => {
            this.safeCall('command', () => this._handleCommand(msg));
        });
        this._subscribed = true;

        this.logger.info(`DmxAdapter: Ready (${this._profileName} fixture at address ${this._address})`);
    }

    handleStateUpdate(_state) {
        // DMX is command-driven; no upstream radio state integration.
    }

    async dispose() {
        this._assertNotDisposed();

        if (this._subscribed) {
            this.mqttClient.unsubscribe(`${this.config.topic}/commands`).catch((err) => {
                this.logger.warn(`DmxAdapter: Unsubscribe error: ${err.message}`);
            });
            this._subscribed = false;
        }

        // Leave the universe running — other adapters may share it.
        // Zero out only this fixture's channels.
        this._applyBlackout();

        this._markDisposed();
        this.logger.info('DmxAdapter: Disposed');
    }

    // ── Command dispatch ─────────────────────────────────────────────────────

    async _handleCommand(msg) {
        this._assertNotDisposed();

        let payload;
        try {
            payload = typeof msg === 'string' ? JSON.parse(msg) : msg;
        } catch {
            this.publishWarning('DMX_CMD_INVALID', 'Command payload must be valid JSON');
            return;
        }

        if (!payload || typeof payload !== 'object') {
            this.publishWarning('DMX_CMD_INVALID', 'Command payload must be a JSON object');
            return;
        }

        const action = payload.action || payload.command;

        try {
            switch (action) {
                case 'on':
                case 'allOn':
                    this._applyOn(this._defaultBrightness);
                    this.publishEvent('all-on');
                    break;

                case 'off':
                case 'allOff':
                    this._applyBlackout();
                    this.publishEvent('all-off');
                    break;

                case 'setBrightness':
                    this._applyBrightness(payload.brightness ?? this._defaultBrightness);
                    this.publishEvent('brightness-updated', { brightness: this._state.brightness });
                    break;

                case 'setColor':
                    this._requireCapability('color', action);
                    this._applyColor(payload);
                    this.publishEvent('color-updated', { color: this._state.color });
                    break;

                case 'scene':
                case 'setColorScene':
                    this._applyColorScene(payload.scene || payload.name || payload.sceneName);
                    break;

                case 'getStatus':
                case 'getState':
                    // State is always retained; re-publish to refresh timestamp.
                    this._publishState();
                    break;

                // Unsupported commands — acknowledged with structured warnings, never silently dropped.
                case 'fade':
                    this.publishWarning(
                        'DMX_CMD_UNSUPPORTED',
                        `"fade" is not supported for DMX fixtures in Phase 2. ` +
                        `Use setBrightness for immediate level changes.`,
                        { command: action }
                    );
                    break;

                case 'setColorTemp':
                    this.publishWarning(
                        'DMX_CMD_UNSUPPORTED',
                        `"setColorTemp" is not supported for DMX RGB fixtures. ` +
                        `Use setColor with an explicit RGB value or a named scene (e.g. warmWhite).`,
                        { command: action }
                    );
                    break;

                default:
                    this.publishWarning('DMX_CMD_UNKNOWN', `Unknown command: "${action}"`, { command: action });
            }
        } catch (err) {
            this.publishWarning('DMX_CMD_FAILED', `Command failed: ${err.message}`, { action });
            return;
        }

        this._publishState();
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Write a brightness level (0–100) to the fixture. For `dimmer` profiles
     * this sets the single intensity channel. For `rgb` profiles this scales
     * the current RGB values (or sets full white at the given brightness if no
     * colour has been set yet).
     */
    _applyBrightness(pct) {
        const b = clamp(pct ?? this._defaultBrightness, 0, 100);
        if (this._profileName === 'dimmer') {
            const dimVal = Math.round(b * 2.55); // 0–100 → 0–255
            this._universe.setChannel(this._address, dimVal);
            this._state.on = b > 0;
            this._state.brightness = b;
        } else if (this._profileName === 'rgb') {
            // Scale existing colour (or white if none set)
            const base = this._state.color ?? { r: 255, g: 255, b: 255 };
            const scale = b / 100;
            this._universe.setChannels({
                [this._address]:     Math.round(base.r * scale),
                [this._address + 1]: Math.round(base.g * scale),
                [this._address + 2]: Math.round(base.b * scale),
            });
            this._state.on = b > 0;
            this._state.brightness = b;
        }
    }

    _applyOn(brightness) {
        if (this._profileName === 'dimmer') {
            this._applyBrightness(brightness);
        } else if (this._profileName === 'rgb') {
            const b = clamp(brightness, 0, 100);
            const base = this._state.color ?? { r: 255, g: 255, b: 255 };
            const scale = b / 100;
            this._universe.setChannels({
                [this._address]:     Math.round(base.r * scale),
                [this._address + 1]: Math.round(base.g * scale),
                [this._address + 2]: Math.round(base.b * scale),
            });
            this._state.on = true;
            this._state.brightness = b;
        }
    }

    _applyBlackout() {
        for (let i = 0; i < this._profile.channels.length; i++) {
            this._universe.setChannel(this._address + i, 0);
        }
        this._state.on = false;
        this._state.brightness = 0;
    }

    _applyColor(payload) {
        const rgb = parseColor(payload.color);
        if (!rgb) {
            this.publishWarning('DMX_COLOR_INVALID',
                `Cannot parse color: ${JSON.stringify(payload.color)}. ` +
                `Provide { r, g, b } or a "#rrggbb" hex string.`);
            return;
        }
        const b = clamp(payload.brightness ?? this._state.brightness ?? 100, 0, 100);
        const scale = b / 100;
        this._universe.setChannels({
            [this._address]:     Math.round(rgb.r * scale),
            [this._address + 1]: Math.round(rgb.g * scale),
            [this._address + 2]: Math.round(rgb.b * scale),
        });
        this._state.on     = b > 0;
        this._state.color  = { r: rgb.r, g: rgb.g, b: rgb.b };
        this._state.brightness = b;
    }

    _applyColorScene(sceneName) {
        if (!sceneName) {
            this.publishWarning('DMX_SCENE_MISSING', 'setColorScene requires a scene name');
            return;
        }
        const scene = this._sceneMap[sceneName];
        if (!scene) {
            this.publishWarning('DMX_SCENE_UNKNOWN',
                `Unknown scene "${sceneName}". Available: ${Object.keys(this._sceneMap).join(', ')}`);
            return;
        }

        if (this._profileName === 'dimmer') {
            this._applyBrightness(scene.brightness ?? 100);
        } else if (this._profileName === 'rgb') {
            const b   = clamp(scene.brightness ?? 100, 0, 100);
            const scale = b / 100;
            this._universe.setChannels({
                [this._address]:     Math.round((scene.r ?? 255) * scale),
                [this._address + 1]: Math.round((scene.g ?? 255) * scale),
                [this._address + 2]: Math.round((scene.b ?? 255) * scale),
            });
            this._state.on    = b > 0;
            this._state.color = { r: scene.r ?? 255, g: scene.g ?? 255, b: scene.b ?? 255 };
            this._state.brightness = b;
        }
        this._state.scene = sceneName;
        this.publishEvent('scene-activated', { scene: sceneName });
    }

    /**
     * Publish a warning and throw if the fixture profile does not support a capability.
     */
    _requireCapability(capability, commandName) {
        if (!this._profile.capabilities.has(capability)) {
            const msg = `Fixture "${this._profileName}" does not support "${commandName}" (missing capability: ${capability})`;
            this.publishWarning('DMX_CMD_UNSUPPORTED', msg, { command: commandName });
            throw new Error(msg);
        }
    }

    _publishState() {
        this.publishState({
            timestamp:  new Date().toISOString(),
            on:         this._state.on,
            brightness: this._state.brightness,
            color:      this._state.color,
            scene:      this._state.scene,
            fixture:    this._profileName,
            address:    this._address,
        });
    }

    /**
     * Parse an optional JSON or key=value scene_map string from the INI.
     * Returns {} on any parse failure (config-level warning, not a startup error).
     */
    _parseSceneMap(raw) {
        if (!raw) return {};
        try {
            // Try JSON first
            return JSON.parse(raw);
        } catch {
            // Fallback: not supported for scene maps — return empty
            this.logger.warn('DmxAdapter: scene_map could not be parsed as JSON; using default scenes only');
            return {};
        }
    }
}

module.exports = DmxAdapter;
