'use strict';

const AdapterBase = require('../adapter-base');
const { loadProfile } = require('../dmx/profiles');

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

const FADE_HZ        = 30;
const MAX_STROBE_HZ  = 15;  // max clean rate at 30 Hz frames: 1 frame on + 1 frame off
const FADE_INTERVAL  = Math.round(1000 / FADE_HZ);  // ~33 ms

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
 * Config keys:
 *   topic      — MQTT topic for this fixture
 *   fixture    — profile name: dimmer | rgb | rgbw | rgba | rgbaw | rgbawuv |
 *                par-7ch | mover-basic | mover-8ch | mover-12ch | custom
 *   channels   — required when fixture = custom; e.g. "dimmer:1,red:2,green:3,blue:4"
 *   address    — DMX start address, 1-based (default 1)
 *   brightness — default brightness 0–100 (default 100)
 *   scene_map  — optional INI-encoded JSON overrides for colour scenes
 *   positions  — optional INI-encoded JSON map of named pan/tilt positions,
 *                e.g. '{"home":{"pan":128,"tilt":64},"door":{"pan":200,"tilt":90}}'
 *                Applicable only when fixture has 'pan' capability.
 *
 * Unsupported commands: `fade`, `setColorTemp` — published as structured warnings,
 * never silently dropped. Documented in docs/MQTT_API.md §9a.
 */
class DmxAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger, universe }) {
        super({ name: 'DmxAdapter', config, mqttClient, logger });

        if (!universe) {
            throw new Error('DmxAdapter: universe is required (no [dmx] section configured or dmx disabled)');
        }

        // Load profile from library (throws descriptively on unknown name or bad custom spec)
        const fixtureName = (config.fixture || '').toLowerCase();
        const profile = loadProfile(fixtureName, { channels: config.channels });

        this._universe    = universe;
        this._profile     = profile;
        this._profileName = fixtureName;
        this._address     = clamp(config.address || 1, 1, 512);
        this._defaultBrightness = clamp(config.brightness ?? 100, 0, 100);

        // Verify the fixture fits within the universe
        const lastSlot = this._address + profile.channels.length - 1;
        if (lastSlot > 512) {
            throw new Error(
                `DmxAdapter: fixture "${config.fixture}" with ${profile.channels.length} channels starting at address ` +
                `${this._address} would end at slot ${lastSlot}, exceeding DMX 512-slot limit`
            );
        }

        // Build slot → absolute DMX address lookup
        this._slotOffset = {};
        for (let i = 0; i < profile.channels.length; i++) {
            this._slotOffset[profile.channels[i]] = this._address + i;
        }

        // Capability set for fast membership tests
        this._caps = new Set(profile.capabilities);

        this._sceneMap = { ...DEFAULT_SCENE_MAP, ...this._parseSceneMap(config.scene_map) };
        this._positions = this._parsePositions(config.positions);

        this._state = {
            on:         false,
            brightness: 0,
            color:      null,
            scene:      null,
            pan:        null,
            tilt:       null,
            // Strobe state (software strobe)
            strobing:   false,
            strobeHz:   null,
            strobeDuty: null,
        };

        this._fadeTimer   = null;  // setTimeout handle for fade tick
        this._strobeTimer = null;  // setTimeout handle for strobe phase

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
        await this.mqttClient.subscribe(`${this.config.topic}/commands`, (_topic, payload) => {
            this.safeCall('command', () => this._handleCommand(payload));
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

        // Cancel any active timers
        this._cancelFade();
        this._cancelStrobe();

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
                case 'allOn': {
                    this._cancelStrobe();
                    const targetB = clamp(payload.brightness ?? this._defaultBrightness, 0, 100);
                    const ft = parseFloat(payload.fadeTime ?? 0);
                    if (ft > 0) {
                        const fromB = this._state.brightness;
                        const fromC = this._state.color;
                        this._applyDefaults();
                        this._startFade(fromB, fromC, targetB, fromC, Math.round(ft * 1000));
                    } else {
                        this._cancelFade();
                        this._applyOn(targetB);
                    }
                    this.publishEvent('all-on');
                    break;
                }

                case 'off':
                case 'allOff': {
                    this._cancelStrobe();
                    const ft = parseFloat(payload.fadeTime ?? 0);
                    if (ft > 0) {
                        const fromB = this._state.brightness;
                        const fromC = this._state.color;
                        this._startFade(fromB, fromC, 0, fromC, Math.round(ft * 1000));
                    } else {
                        this._cancelFade();
                        this._applyBlackout();
                    }
                    this.publishEvent('all-off');
                    break;
                }

                case 'setBrightness': {
                    this._cancelStrobe();
                    const targetB = clamp(payload.brightness ?? this._defaultBrightness, 0, 100);
                    const ft = parseFloat(payload.fadeTime ?? 0);
                    if (ft > 0) {
                        const fromB = this._state.brightness;
                        const fromC = this._state.color;
                        this._startFade(fromB, fromC, targetB, fromC, Math.round(ft * 1000));
                    } else {
                        this._cancelFade();
                        this._applyBrightness(targetB);
                        this.publishEvent('brightness-updated', { brightness: this._state.brightness });
                    }
                    break;
                }

                case 'setColor': {
                    this._requireCapability('color', action);
                    this._cancelStrobe();
                    const ft = parseFloat(payload.fadeTime ?? 0);
                    if (ft > 0) {
                        const fromB = this._state.brightness;
                        const fromC = this._state.color ?? { r: 0, g: 0, b: 0 };
                        const toRgb = parseColor(payload.color);
                        if (!toRgb) {
                            this.publishWarning('DMX_COLOR_INVALID',
                                `Cannot parse color: ${JSON.stringify(payload.color)}`);
                            break;
                        }
                        const toB = clamp(payload.brightness ?? fromB, 0, 100);
                        this._startFade(fromB, fromC, toB, toRgb, Math.round(ft * 1000));
                    } else {
                        this._cancelFade();
                        this._applyColor(payload);
                        this.publishEvent('color-updated', { color: this._state.color });
                    }
                    break;
                }

                case 'scene':
                case 'setColorScene':
                    this._cancelFade();
                    this._cancelStrobe();
                    this._applyColorScene(payload.scene || payload.name || payload.sceneName);
                    break;

                case 'getStatus':
                case 'getState':
                    this._publishState();
                    break;

                case 'fade': {
                    this._cancelStrobe();
                    const ft = parseFloat(payload.fadeTime ?? 0);
                    const toB   = payload.brightness !== undefined
                        ? clamp(payload.brightness, 0, 100)
                        : (payload.off ? 0 : this._state.brightness);
                    const toRgb = payload.color ? parseColor(payload.color) : (this._state.color ?? null);
                    if (ft > 0) {
                        const fromB = this._state.brightness;
                        const fromC = this._state.color ?? { r: 0, g: 0, b: 0 };
                        this._startFade(fromB, fromC, toB, toRgb, Math.round(ft * 1000));
                    } else {
                        this._cancelFade();
                        if (payload.color) this._applyColor({ color: toRgb, brightness: toB });
                        else this._applyBrightness(toB);
                    }
                    break;
                }

                case 'setColorTemp':
                    this.publishWarning(
                        'DMX_CMD_UNSUPPORTED',
                        '"setColorTemp" is not supported for DMX fixtures. ' +
                        'Use setColor with explicit RGB values, a named scene (e.g. warmWhite), ' +
                        'or a RGBW/RGBAW scene_map entry for white-channel fixtures.',
                        { command: action }
                    );
                    break;

                case 'moveTo': {
                    this._cancelFade();
                    this._cancelStrobe();
                    this._requireCapability('pan', 'moveTo');
                    const target = this._resolvePosition(payload);
                    if (target) {
                        this._applyPosition(target.pan, target.tilt, target.speed ?? 0);
                        this.publishEvent('moved', { pan: target.pan, tilt: target.tilt });
                    }
                    break;
                }

                case 'home': {
                    this._cancelFade();
                    this._cancelStrobe();
                    this._requireCapability('pan', 'home');
                    const hp = this._positions['home'];
                    this._applyPosition(hp.pan, hp.tilt, hp.speed ?? 0);
                    this.publishEvent('moved', { pan: hp.pan, tilt: hp.tilt });
                    break;
                }

                case 'setStrobe': {
                    this._cancelFade();
                    const hz    = Math.max(0.1, parseFloat(payload.strobeHz   ?? 1));
                    const duty  = Math.max(1,   Math.min(99, parseFloat(payload.strobeDuty ?? 50)));
                    const color = payload.color ?? this._state.color ?? { r: 255, g: 255, b: 255 };
                    const brightness = payload.brightness ?? this._state.brightness ?? 100;
                    this._startStrobe(hz, duty, color, brightness);
                    this.publishEvent('strobe-started', {
                        strobeHz:   this._state.strobeHz,
                        strobeDuty: this._state.strobeDuty,
                        color, brightness,
                    });
                    break;
                }

                case 'stopStrobe': {
                    this._cancelStrobe();
                    if (payload.color) {
                        this._applyColor(payload);
                    } else if (payload.brightness !== undefined) {
                        this._applyBrightness(payload.brightness);
                    } else {
                        this._applyBlackout();
                    }
                    this.publishEvent('strobe-stopped');
                    break;
                }

                case 'setDmxStrobe': {
                    this._requireCapability('strobe', 'setDmxStrobe');
                    const val = Math.max(0, Math.min(255, Math.round(payload.value ?? 0)));
                    this._universe.setChannel(this._slotOffset['strobe'], val);
                    this._state.hardwareStrobe = val;
                    break;
                }

                case 'dmxStrobeOff': {
                    if ('strobe' in this._slotOffset) {
                        this._universe.setChannel(this._slotOffset['strobe'], 0);
                        this._state.hardwareStrobe = 0;
                    }
                    break;
                }

                default:
                    this.publishWarning('DMX_CMD_UNKNOWN', `Unknown command: "${action}"`, { command: action });
            }
        } catch (err) {
            this.publishWarning('DMX_CMD_FAILED', `Command failed: ${err.message}`, { action });
            return;
        }

        this._publishState();
    }

    // ── Fade ─────────────────────────────────────────────────────────────────────

    _cancelFade() {
        if (this._fadeTimer) {
            clearTimeout(this._fadeTimer);
            this._fadeTimer = null;
        }
    }

    /**
     * Fade from one brightness/color to another over durationMs milliseconds.
     * Runs at FADE_HZ using chained setTimeout calls.
     *
     * @param {number}        fromB      Starting brightness (0–100)
     * @param {{r,g,b}|null}  fromC      Starting color (or null = no color channels)
     * @param {number}        toB        Target brightness (0–100)
     * @param {{r,g,b}|null}  toC        Target color (or null = keep fromC)
     * @param {number}        durationMs Total fade duration in milliseconds
     */
    _startFade(fromB, fromC, toB, toC, durationMs) {
        this._cancelFade();
        if (durationMs <= 0) {
            // Immediate apply
            if (toC) this._applyColor({ color: toC, brightness: toB });
            else     this._applyBrightness(toB);
            this._publishState();
            return;
        }

        const startMs  = Date.now();
        const resolvedFromC = fromC ?? { r: 255, g: 255, b: 255 };
        const resolvedToC   = toC   ?? resolvedFromC;
        const hasColor = this._hasColorChannels() && (fromC || toC);

        const tick = () => {
            const elapsed = Date.now() - startMs;
            const t = Math.min(1, elapsed / durationMs);

            const b = fromB + (toB - fromB) * t;
            const c = hasColor ? {
                r: Math.round(resolvedFromC.r + (resolvedToC.r - resolvedFromC.r) * t),
                g: Math.round(resolvedFromC.g + (resolvedToC.g - resolvedFromC.g) * t),
                b: Math.round(resolvedFromC.b + (resolvedToC.b - resolvedFromC.b) * t),
            } : null;

            if (hasColor && c) {
                this._applyColor({ color: c, brightness: Math.round(b) });
            } else {
                this._applyBrightness(Math.round(b));
            }
            this._publishState();

            if (t < 1) {
                this._fadeTimer = setTimeout(tick, FADE_INTERVAL);
            } else {
                this._fadeTimer = null;
            }
        };

        this._fadeTimer = setTimeout(tick, FADE_INTERVAL);
    }

    // ── Software strobe ────────────────────────────────────────────────────────

    _cancelStrobe() {
        if (this._strobeTimer) {
            clearTimeout(this._strobeTimer);
            this._strobeTimer = null;
        }
        this._state.strobing   = false;
        this._state.strobeHz   = null;
        this._state.strobeDuty = null;
    }

    _startStrobe(hz, duty, color, brightness) {
        if (hz > MAX_STROBE_HZ) {
            this.publishWarning('DMX_STROBE_HZ_CLAMPED',
                `strobeHz ${hz} exceeds maximum ${MAX_STROBE_HZ} Hz; clamped.`,
                { requested: hz, clamped: MAX_STROBE_HZ });
            hz = MAX_STROBE_HZ;
        }
        this._cancelStrobe();

        // Quantize to frame boundaries: each on/off phase is an integer number
        // of FADE_INTERVAL (~33 ms) ticks so transitions land exactly on a
        // DMX frame send rather than falling between frames.
        const totalFrames = Math.max(2, Math.round(FADE_HZ / hz));
        const onFrames    = Math.max(1, Math.round(totalFrames * duty / 100));
        const offFrames   = Math.max(1, totalFrames - onFrames);
        const actualHz    = FADE_HZ / (onFrames + offFrames);

        this._state.strobing   = true;
        this._state.strobeHz   = Math.round(actualHz * 100) / 100;
        this._state.strobeDuty = Math.round(onFrames / (onFrames + offFrames) * 100);

        let frameCount = 0;
        let phase = 'on';
        this._writeStrobeOn(color, brightness);

        this._strobeTimer = setInterval(() => {
            frameCount++;
            if (phase === 'on' && frameCount >= onFrames) {
                phase = 'off';
                frameCount = 0;
                this._writeStrobeOff();
            } else if (phase === 'off' && frameCount >= offFrames) {
                phase = 'on';
                frameCount = 0;
                this._writeStrobeOn(color, brightness);
            }
        }, FADE_INTERVAL);

        this._publishState();
    }

    /**
     * Write strobe-ON frame directly to the universe without updating `_state`.
     * (Strobe alternates the physical wire; logical state stays intact for restore.)
     */
    _writeStrobeOn(color, brightness) {
        const rgb = parseColor(color) || { r: 255, g: 255, b: 255 };
        const b   = Math.max(0, Math.min(100, parseFloat(brightness ?? 100)));
        const update = {};

        if ('dimmer' in this._slotOffset) {
            update[this._slotOffset['dimmer']] = Math.round(b * 2.55);
            if ('red'   in this._slotOffset) update[this._slotOffset['red']]   = rgb.r;
            if ('green' in this._slotOffset) update[this._slotOffset['green']] = rgb.g;
            if ('blue'  in this._slotOffset) update[this._slotOffset['blue']]  = rgb.b;
        } else {
            const scale = b / 100;
            if ('red'   in this._slotOffset) update[this._slotOffset['red']]   = Math.round(rgb.r * scale);
            if ('green' in this._slotOffset) update[this._slotOffset['green']] = Math.round(rgb.g * scale);
            if ('blue'  in this._slotOffset) update[this._slotOffset['blue']]  = Math.round(rgb.b * scale);
        }

        if (Object.keys(update).length) this._universe.setChannels(update);
    }

    /** Zero all fixture channels for the off-phase of a software strobe. */
    _writeStrobeOff() {
        const update = {};
        for (let i = 0; i < this._profile.channels.length; i++) {
            update[this._address + i] = 0;
        }
        this._universe.setChannels(update);
    }

    // ── Channel helpers ──────────────────────────────────────────────────────────────
    _hasColorChannels() {
        return 'red' in this._slotOffset || 'green' in this._slotOffset || 'blue' in this._slotOffset;
    }

    /** Apply profile.defaults to the universe (pinned mode/speed/strobe channels). */
    _applyDefaults() {
        const defs = this._profile.defaults;
        if (!defs) return;
        for (const [slot, val] of Object.entries(defs)) {
            if (slot in this._slotOffset) {
                this._universe.setChannel(this._slotOffset[slot], val);
            }
        }
    }

    /**
     * Apply brightness (0–100) to the fixture.
     * - Profiles with a `dimmer` slot: set that channel to 0–255.
     * - Profiles without `dimmer` (rgb, rgbw, …): scale current color channels.
     */
    _applyBrightness(pct) {
        const b = clamp(pct ?? this._defaultBrightness, 0, 100);

        if ('dimmer' in this._slotOffset) {
            this._universe.setChannel(this._slotOffset['dimmer'], Math.round(b * 2.55));
            this._state.on = b > 0;
            this._state.brightness = b;
        } else if (this._hasColorChannels()) {
            const base  = this._state.color ?? { r: 255, g: 255, b: 255 };
            const scale = b / 100;
            const update = {};
            if ('red'   in this._slotOffset) update[this._slotOffset['red']]   = Math.round(base.r * scale);
            if ('green' in this._slotOffset) update[this._slotOffset['green']] = Math.round(base.g * scale);
            if ('blue'  in this._slotOffset) update[this._slotOffset['blue']]  = Math.round(base.b * scale);
            this._universe.setChannels(update);
            this._state.on = b > 0;
            this._state.brightness = b;
        }
    }

    _applyOn(brightness) {
        const b = clamp(brightness ?? this._defaultBrightness, 0, 100);
        // Re-apply defaults (e.g. mode pin for par-7ch) before activating
        this._applyDefaults();
        this._applyBrightness(b);
        this._state.on = b > 0;
    }

    _applyBlackout() {
        for (let i = 0; i < this._profile.channels.length; i++) {
            this._universe.setChannel(this._address + i, 0);
        }
        this._state.on = false;
        this._state.brightness = 0;
    }

    /**
     * Apply an RGB color value.
     * - Profiles with a `dimmer` slot: set RGB channels to full intensity values;
     *   update dimmer only if `brightness` is explicitly in the payload.
     * - Profiles without `dimmer`: scale RGB channels by brightness.
     */
    _applyColor(payload) {
        const rgb = parseColor(payload.color);
        if (!rgb) {
            this.publishWarning('DMX_COLOR_INVALID',
                `Cannot parse color: ${JSON.stringify(payload.color)}. ` +
                'Provide { r, g, b } or a "#rrggbb" hex string.');
            return;
        }

        const b = clamp(payload.brightness ?? this._state.brightness ?? 100, 0, 100);

        if ('dimmer' in this._slotOffset) {
            // Set RGB at full values; master dimmer handles brightness
            const update = {};
            if ('red'   in this._slotOffset) update[this._slotOffset['red']]   = rgb.r;
            if ('green' in this._slotOffset) update[this._slotOffset['green']] = rgb.g;
            if ('blue'  in this._slotOffset) update[this._slotOffset['blue']]  = rgb.b;
            if (Object.keys(update).length) this._universe.setChannels(update);
            if (payload.brightness !== undefined) {
                this._universe.setChannel(this._slotOffset['dimmer'], Math.round(b * 2.55));
            }
        } else {
            const scale = b / 100;
            const update = {};
            if ('red'   in this._slotOffset) update[this._slotOffset['red']]   = Math.round(rgb.r * scale);
            if ('green' in this._slotOffset) update[this._slotOffset['green']] = Math.round(rgb.g * scale);
            if ('blue'  in this._slotOffset) update[this._slotOffset['blue']]  = Math.round(rgb.b * scale);
            if (Object.keys(update).length) this._universe.setChannels(update);
        }

        this._state.on         = b > 0;
        this._state.color      = { r: rgb.r, g: rgb.g, b: rgb.b };
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

        const b = clamp(scene.brightness ?? 100, 0, 100);

        if (this._hasColorChannels()) {
            this._applyColor({
                color:      { r: scene.r ?? 255, g: scene.g ?? 255, b: scene.b ?? 255 },
                brightness: b,
            });
        } else {
            this._applyBrightness(b);
        }

        this._state.scene = sceneName;
        this.publishEvent('scene-activated', { scene: sceneName });
    }

    _requireCapability(capability, commandName) {
        if (!this._caps.has(capability)) {
            const msg = `Fixture "${this._profileName}" does not support "${commandName}" (missing capability: ${capability})`;
            this.publishWarning('DMX_CMD_UNSUPPORTED', msg, { command: commandName });
            throw new Error(msg);
        }
    }

    _publishState() {
        const s = {
            timestamp:  new Date().toISOString(),
            on:         this._state.on,
            brightness: this._state.brightness,
            color:      this._state.color,
            scene:      this._state.scene,
            fixture:    this._profileName,
            address:    this._address,
        };
        if (this._caps.has('pan')) {
            s.pan  = this._state.pan;
            s.tilt = this._state.tilt;
        }
        if (this._state.strobing) {
            s.strobing   = true;
            s.strobeHz   = this._state.strobeHz;
            s.strobeDuty = this._state.strobeDuty;
        }
        if ('strobe' in this._slotOffset && this._state.hardwareStrobe !== undefined) {
            s.hardwareStrobe = this._state.hardwareStrobe;
        }
        this.publishState(s);
    }

    _parseSceneMap(raw) {
        if (!raw) return {};
        try {
            return JSON.parse(raw);
        } catch {
            this.logger.warn('DmxAdapter: scene_map could not be parsed as JSON; using default scenes only');
            return {};
        }
    }

    _parsePositions(raw) {
        const defaults = { home: { pan: 128, tilt: 128 } };
        if (!raw) return defaults;
        try {
            return { ...defaults, ...JSON.parse(raw) };
        } catch {
            this.logger.warn('DmxAdapter: positions could not be parsed as JSON; using default home position only');
            return defaults;
        }
    }

    /**
     * Resolve a moveTo payload to a {pan, tilt, speed} object.
     * Returns null and publishes a warning if the position cannot be resolved.
     */
    _resolvePosition(payload) {
        if (payload.position !== undefined) {
            const p = this._positions[payload.position];
            if (!p) {
                this.publishWarning('DMX_POSITION_UNKNOWN',
                    `Position "${payload.position}" not found. Defined: ${Object.keys(this._positions).join(', ')}`,
                    { position: payload.position });
                return null;
            }
            return { pan: p.pan, tilt: p.tilt, speed: p.speed ?? 0 };
        }
        if (payload.pan === undefined && payload.tilt === undefined) {
            this.publishWarning('DMX_CMD_INVALID',
                'moveTo requires either a "position" name or explicit "pan"/"tilt" values');
            return null;
        }
        return {
            pan:   payload.pan  !== undefined ? clamp(payload.pan,  0, 255) : (this._state.pan  ?? 128),
            tilt:  payload.tilt !== undefined ? clamp(payload.tilt, 0, 255) : (this._state.tilt ?? 128),
            speed: payload.speed !== undefined ? clamp(payload.speed, 0, 255) : 0,
        };
    }

    /** Write pan/tilt (and fine channels if present) and speed to the universe. */
    _applyPosition(pan, tilt, speed = 0) {
        const update = {};
        if ('pan'       in this._slotOffset) update[this._slotOffset['pan']]       = clamp(pan,   0, 255);
        if ('tilt'      in this._slotOffset) update[this._slotOffset['tilt']]      = clamp(tilt,  0, 255);
        if ('pan_fine'  in this._slotOffset) update[this._slotOffset['pan_fine']]  = 0;
        if ('tilt_fine' in this._slotOffset) update[this._slotOffset['tilt_fine']] = 0;
        if ('speed'     in this._slotOffset) update[this._slotOffset['speed']]     = clamp(speed, 0, 255);
        this._universe.setChannels(update);
        this._state.pan  = clamp(pan,  0, 255);
        this._state.tilt = clamp(tilt, 0, 255);
        this._state.on   = true;
    }
}

module.exports = DmxAdapter;
