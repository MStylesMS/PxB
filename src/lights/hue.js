/**
 * src/lights/hue.js — Philips Hue light adapter for PxB
 *
 * Manages Philips Hue light control via the Hue Bridge API.
 * Extends AdapterBase and publishes state/events to MQTT.
 */

'use strict';

const AdapterBase = require('../adapter-base');

const GAMUT_B = {
    r: { x: 0.675, y: 0.322 },
    g: { x: 0.409, y: 0.518 },
    b: { x: 0.167, y: 0.040 },
};

/**
 * Named color scenes. Each entry maps to Hue light parameters.
 * Names match the WiZ backend for cross-backend compatibility.
 */
const HUE_COLOR_SCENES = {
    normal:      { on: true, kelvin: 4000, r: 255, g: 255, b: 255, brightness: 80 },
    dim:         { on: true, brightness: 35 },
    red:         { on: true, r: 255, g: 0,   b: 0,   brightness: 80 },
    blue:        { on: true, r: 0,   g: 0,   b: 255, brightness: 75 },
    green:       { on: true, r: 0,   g: 255, b: 0,   brightness: 75 },
    yellow:      { on: true, r: 255, g: 220, b: 0,   brightness: 80 },
    orange:      { on: true, r: 255, g: 110, b: 0,   brightness: 80 },
    purple:      { on: true, r: 170, g: 60,  b: 255, brightness: 75 },
    pink:        { on: true, r: 255, g: 105, b: 180, brightness: 75 },
    cyan:        { on: true, r: 0,   g: 220, b: 255, brightness: 75 },
    magenta:     { on: true, r: 255, g: 0,   b: 200, brightness: 75 },
    white:       { on: true, kelvin: 4000,   brightness: 75 },
    softWhite:   { on: true, kelvin: 2700,   brightness: 70 },
    brightWhite: { on: true, kelvin: 6500,   brightness: 100 },
    warmWhite:   { on: true, kelvin: 2200,   brightness: 80 },
    coolWhite:   { on: true, kelvin: 6000,   brightness: 85 },
    off:         { on: false },
};

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
        this.profile = (config.hue_profile || config.hueProfile || 'color').toLowerCase();
        this.targetType = String(config.hue_target_type || 'all').toLowerCase();
        this.targetId = config.hue_target_id ? String(config.hue_target_id) : null;
        this.timeoutMs = (config.timeout_s || 10) * 1000;
        this.sceneMap = {
            ...HUE_COLOR_SCENES,
            ...this._parseSceneMap(config.scene_map),
        };

        if (!this.host || !this.apiKey) {
            throw new Error('HueAdapter: config.host and config.api_key required');
        }

        if (!new Set(['all', 'group', 'light']).has(this.targetType)) {
            throw new Error('HueAdapter: config.hue_target_type must be one of all, group, light');
        }

        if (this.targetType === 'all' && this.targetId) {
            throw new Error('HueAdapter: config.hue_target_id is only valid for group or light targets');
        }

        if (this.targetType !== 'all' && !this.targetId) {
            throw new Error(`HueAdapter: config.hue_target_id required for ${this.targetType} target`);
        }

        this.lights = new Map();     // light_id → { state, reachable, ... }
        this.updateTimer = null;
        this._subscribed = false;
        this._pollFailCount = 0;
        this._connectivity = 'online'; // 'online' | 'degraded'
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
            this.logger.info(`HueAdapter: Found ${Object.keys(lights).length} lights for ${this._describeTarget()}`);
        } catch (err) {
            this.publishWarning('HUE_INIT_FAILED', `Failed to fetch lights: ${err.message}`);
            throw err;
        }

        // Subscribe to command topic
        const commandTopic = `${this.config.topic}/commands`;
        this.mqttClient.subscribe(commandTopic, (_topic, payload) =>
            this.safeCall('command', () => this._handleCommand(payload)));
        this._subscribed = true;
        this.logger.info(`HueAdapter: Subscribed to ${commandTopic}`);

        // Publish initial state
        this._publishState();

        // Start polling for state updates every 5s
        // eslint-disable-next-line no-restricted-syntax -- safeCall wraps this callback
        this.updateTimer = setInterval(() =>
            this.safeCall('poll', () => this._pollState()), 5000);

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
                case 'scene':
                    await this._applyColorScene(payload.scene || payload.name);
                    break;
                case 'setLight':
                    await this._setLight(payload);
                    break;
                case 'setScene':
                    if (payload.sceneId !== undefined) {
                        await this._setScene(payload);
                    } else {
                        await this._applyColorScene(payload.scene || payload.name);
                    }
                    break;
                case 'setColorScene':
                    await this._applyColorScene(payload.scene || payload.name);
                    break;
                case 'on':
                case 'allOn':
                    await this._turnOn(payload);
                    break;
                case 'off':
                case 'allOff':
                    await this._turnOff();
                    break;
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
    handleStateUpdate(_state) {
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
            try {
                await this.mqttClient.unsubscribe(commandTopic);
            } catch (err) {
                this.logger.warn(`HueAdapter: Unsubscribe error: ${err.message}`);
            }
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
        if (this.targetType === 'light') {
            const response = await this._httpGet(this._getLightsUrl(this.targetId));
            return { [this.targetId]: response };
        }

        if (this.targetType === 'group') {
            const [group, allLights] = await Promise.all([
                this._httpGet(this._getGroupsUrl(this.targetId)),
                this._httpGet(this._getLightsUrl()),
            ]);
            const scopedLights = {};
            for (const lightId of group?.lights || []) {
                if (allLights[lightId]) {
                    scopedLights[lightId] = allLights[lightId];
                }
            }
            return scopedLights;
        }

        return this._httpGet(this._getLightsUrl());
    }

    /**
     * Set a single light's state.
     * Payload: { lightId: '1', on: true, brightness: 200, hue: 10000, sat: 254, ... }
     */
    async _setLight(payload) {
        const { lightId, on, brightness, hue, sat, ct, transitiontime } = payload;
        const resolvedLightId = lightId || (this.targetType === 'light' ? this.targetId : null);

        if (!resolvedLightId) {
            this.publishWarning('HUE_SETLIGHT_MISSING_ID', 'lightId is required unless the adapter targets a single configured light');
            return;
        }

        const state = {};
        if (on !== undefined) state.on = Boolean(on);
        if (brightness !== undefined) state.bri = Math.max(0, Math.min(254, brightness));
        if (hue !== undefined) state.hue = hue;
        if (sat !== undefined) state.sat = sat;
        if (ct !== undefined) state.ct = ct;
        if (transitiontime !== undefined) state.transitiontime = transitiontime;

        const url = this._getLightStateUrl(resolvedLightId);
        const response = await this._httpPut(url, state);

        // Verify success
        if (response && Array.isArray(response) && response[0].success) {
            this.publishEvent('light-updated', { lightId: resolvedLightId, state });
            this.logger.info(`HueAdapter: Light ${resolvedLightId} updated`);
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

        if (this.targetType === 'light') {
            throw new Error('Hue sceneId recall is only supported for all-lights or group targets');
        }

        const state = { scene: sceneId };
        if (transition) state.transition = transition;

        const url = this._getActionUrl();
        const response = await this._httpPut(url, state);

        if (response && Array.isArray(response) && response[0].success) {
            this.publishEvent('scene-activated', { sceneId });
            this.logger.info(`HueAdapter: Scene ${sceneId} activated`);
            await this._pollState();
        } else {
            throw new Error(`Hue scene error: ${JSON.stringify(response)}`);
        }
    }

    async _applyColorScene(sceneName) {
        if (!sceneName) { this.publishWarning('HUE_SCENE_MISSING_NAME', 'scene name is required'); return; }
        const scene = this.sceneMap[sceneName]
            ?? this.sceneMap[Object.keys(this.sceneMap).find((k) => k.toLowerCase() === sceneName.toLowerCase())];
        if (!scene) { this.publishWarning('HUE_SCENE_UNKNOWN', `Unknown scene '${sceneName}'`); return; }

        const url = this._getActionUrl();
        if (!scene.on) {
            await this._httpPut(url, { on: false });
            this.publishEvent('scene-activated', { scene: sceneName });
            await this._pollState();
            return;
        }

        const state = this._buildSceneState(scene);

        await this._httpPut(url, state);
        this.publishEvent('scene-activated', { scene: sceneName });
        await this._pollState();
    }

    async _turnOn(payload) {
        const state = { on: true };
        if (payload.brightness !== undefined) {
            state.bri = this._pctToHueBri(this._clampBrightness(payload.brightness));
        }
        const url = this._getActionUrl();
        const response = await this._httpPut(url, state);
        if (response && Array.isArray(response) && response[0].success) {
            this.publishEvent('all-on');
            await this._pollState();
            return;
        }
        throw new Error(`Hue on error: ${JSON.stringify(response)}`);
    }

    async _turnOff() {
        const url = this._getActionUrl();
        const response = await this._httpPut(url, { on: false });
        if (response && Array.isArray(response) && response[0].success) {
            this.publishEvent('all-off');
            await this._pollState();
            return;
        }
        throw new Error(`Hue off error: ${JSON.stringify(response)}`);
    }

    async _setBrightness(payload) {
        const briPct = this._clampBrightness(payload.brightness);
        const state = {
            on: briPct > 0,
            bri: this._pctToHueBri(briPct),
        };
        const url = this._getActionUrl();
        const response = await this._httpPut(url, state);
        if (response && Array.isArray(response) && response[0].success) {
            this.publishEvent('brightness-updated', { brightness: briPct });
            await this._pollState();
            return;
        }
        throw new Error(`Hue brightness error: ${JSON.stringify(response)}`);
    }

    async _setColor(payload) {
        const rgb = this._parseColor(payload.color);
        const state = this._buildColorState(rgb.r, rgb.g, rgb.b, payload.brightness ?? 100);
        const url = this._getActionUrl();
        const response = await this._httpPut(url, state);
        if (response && Array.isArray(response) && response[0].success) {
            this.publishEvent('color-updated', { color: payload.color });
            await this._pollState();
            return;
        }
        throw new Error(`Hue color error: ${JSON.stringify(response)}`);
    }

    async _setColorTemp(payload) {
        const kelvin = Number.parseInt(payload.kelvin, 10) || 4000;
        const state = {
            on: true,
            bri: this._pctToHueBri(this._clampBrightness(payload.brightness ?? 100)),
        };

        if (this.profile === 'ct') {
            state.ct = this._kelvinToCt(kelvin);
        } else if (this.profile === 'color') {
            const rgb = this._kelvinToRgb(kelvin);
            const xy = this._rgbToXy(rgb.r, rgb.g, rgb.b);
            state.xy = [xy.x, xy.y];
        }

        const url = this._getActionUrl();
        const response = await this._httpPut(url, state);
        if (response && Array.isArray(response) && response[0].success) {
            this.publishEvent('color-temperature-updated', { kelvin });
            await this._pollState();
            return;
        }
        throw new Error(`Hue color temp error: ${JSON.stringify(response)}`);
    }

    async _fade(payload) {
        await this._setBrightness(payload);
        this.publishWarning('HUE_CMD_LIMITATION', 'Hue fade duration not implemented; applied immediate brightness change');
    }

    _buildSceneState(scene) {
        const state = { on: true };
        const bri = scene.brightness !== undefined ? this._clampBrightness(scene.brightness) : undefined;
        if (bri !== undefined) {
            state.bri = this._pctToHueBri(bri);
        }

        if (this.profile === 'dim') {
            return state;
        }

        if (this.profile === 'ct') {
            const kelvin = scene.kelvin ?? this._rgbToKelvin(scene.r, scene.g, scene.b);
            if (kelvin !== undefined) {
                state.ct = this._kelvinToCt(kelvin);
            }
            return state;
        }

        if (scene.r !== undefined && scene.g !== undefined && scene.b !== undefined) {
            const xy = this._rgbToXy(scene.r, scene.g, scene.b);
            state.xy = [xy.x, xy.y];
        } else if (scene.kelvin !== undefined) {
            const rgb = this._kelvinToRgb(scene.kelvin);
            const xy = this._rgbToXy(rgb.r, rgb.g, rgb.b);
            state.xy = [xy.x, xy.y];
        }

        return state;
    }

    _buildColorState(r, g, b, brightness) {
        const state = {
            on: true,
            bri: this._pctToHueBri(this._clampBrightness(brightness)),
        };

        if (this.profile === 'dim') {
            return state;
        }

        if (this.profile === 'ct') {
            const kelvin = this._rgbToKelvin(r, g, b);
            if (kelvin !== undefined) {
                state.ct = this._kelvinToCt(kelvin);
            }
            return state;
        }

        const xy = this._rgbToXy(r, g, b);
        state.xy = [xy.x, xy.y];
        return state;
    }

    /**
     * Turn all lights on.
     */
    async _allOn() {
        const url = this._getActionUrl();
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
        const url = this._getActionUrl();
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
            if (this._connectivity !== 'online') {
                this._connectivity = 'online';
                this._pollFailCount = 0;
                this.logger.info(`HueAdapter: ${this.host} recovered`);
            }
            this._publishState();
        } catch (err) {
            this._pollFailCount++;
            this.logger.warn(`HueAdapter: Poll failed (${this._pollFailCount}): ${err.message}`);
            if (this._pollFailCount >= 3 && this._connectivity !== 'degraded') {
                this._connectivity = 'degraded';
                this._publishDegraded(err.message);
            }
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
            status: 'online',
            lights,
        });
    }

    _publishDegraded(reason) {
        this.publishWarning('HUE_BRIDGE_UNREACHABLE', `Bridge at ${this.host} is not responding: ${reason}`);
        this.publishState({
            type: 'hue',
            status: 'degraded',
            host: this.host,
            reason,
            timestamp: new Date().toISOString(),
        });
    }

    _parseSceneMap(raw) {
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                this.logger.warn('HueAdapter: scene_map must be a JSON object; ignoring');
                return {};
            }
            return parsed;
        } catch (err) {
            this.logger.warn(`HueAdapter: Failed to parse scene_map JSON: ${err.message}`);
            return {};
        }
    }

    _getApiRoot() {
        return `http://${this.host}:${this.port}/api/${this.apiKey}`;
    }

    _getLightsUrl(lightId = null) {
        return lightId
            ? `${this._getApiRoot()}/lights/${lightId}`
            : `${this._getApiRoot()}/lights`;
    }

    _getGroupsUrl(groupId = null) {
        return groupId
            ? `${this._getApiRoot()}/groups/${groupId}`
            : `${this._getApiRoot()}/groups`;
    }

    _getLightStateUrl(lightId) {
        return `${this._getApiRoot()}/lights/${lightId}/state`;
    }

    _getActionUrl() {
        if (this.targetType === 'light') {
            return this._getLightStateUrl(this.targetId);
        }

        const groupId = this.targetType === 'group' ? this.targetId : '0';
        return `${this._getApiRoot()}/groups/${groupId}/action`;
    }

    _describeTarget() {
        if (this.targetType === 'all') return 'all lights';
        return `${this.targetType} ${this.targetId}`;
    }

    _pctToHueBri(value) {
        return Math.max(0, Math.min(254, Math.round((value / 100) * 254)));
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

    _rgbToXy(r, g, b) {
        const toLinear = (c) => {
            const srgb = c / 255;
            return srgb > 0.04045 ? Math.pow((srgb + 0.055) / 1.055, 2.4) : srgb / 12.92;
        };

        const rL = toLinear(r);
        const gL = toLinear(g);
        const bL = toLinear(b);

        const X = rL * 0.664511 + gL * 0.154324 + bL * 0.162028;
        const Y = rL * 0.283881 + gL * 0.668433 + bL * 0.047685;
        const Z = rL * 0.000088 + gL * 0.07231 + bL * 0.986039;
        const sum = X + Y + Z;

        if (sum === 0) {
            return { x: 0.3127, y: 0.3290 };
        }

        return this._clampToGamutB(X / sum, Y / sum);
    }

    _clampToGamutB(x, y) {
        const point = { x, y };
        const { r, g, b } = GAMUT_B;

        if (this._isInGamutTriangle(point, r, g, b)) {
            return point;
        }

        const pRG = this._closestPointOnSegment(r, g, point);
        const pGB = this._closestPointOnSegment(g, b, point);
        const pBR = this._closestPointOnSegment(b, r, point);

        const dRG = this._distSq(point, pRG);
        const dGB = this._distSq(point, pGB);
        const dBR = this._distSq(point, pBR);

        if (dRG <= dGB && dRG <= dBR) return pRG;
        if (dGB <= dRG && dGB <= dBR) return pGB;
        return pBR;
    }

    _isInGamutTriangle(p, v1, v2, v3) {
        const d1 = this._crossProduct(p, v1, v2);
        const d2 = this._crossProduct(p, v2, v3);
        const d3 = this._crossProduct(p, v3, v1);
        const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
        const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        return !(hasNeg && hasPos);
    }

    _crossProduct(p, a, b) {
        return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
    }

    _closestPointOnSegment(a, b, p) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return a;

        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
        return { x: a.x + t * dx, y: a.y + t * dy };
    }

    _distSq(a, b) {
        return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    }

    _kelvinToCt(kelvin) {
        const mirek = Math.round(1000000 / kelvin);
        return Math.max(153, Math.min(500, mirek));
    }

    _rgbToKelvin(r, g, b) {
        if (r === undefined || g === undefined || b === undefined) return undefined;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max === 0 || (max - min) / max > 0.25) return undefined;
        const ratio = r / (r + b + 1);
        return Math.round(2000 + ratio * 4500);
    }

    _kelvinToRgb(kelvin) {
        const temp = kelvin / 100;
        let red;
        let green;
        let blue;

        if (temp <= 66) {
            red = 255;
            green = Math.round(99.4708025861 * Math.log(temp) - 161.1195681661);
            blue = temp <= 19 ? 0 : Math.round(138.5177312231 * Math.log(temp - 10) - 305.0447927307);
        } else {
            red = Math.round(329.698727446 * Math.pow(temp - 60, -0.1332047592));
            green = Math.round(288.1221695283 * Math.pow(temp - 60, -0.0755148492));
            blue = 255;
        }

        return {
            r: Math.max(0, Math.min(255, red)),
            g: Math.max(0, Math.min(255, green)),
            b: Math.max(0, Math.min(255, blue)),
        };
    }

    /**
     * Handle inbound MQTT command message.
     */
    async _handleCommand(payload) {
        try {
            const cmd = typeof payload === 'string' ? JSON.parse(payload) : payload;
            await this.executeCommand(cmd);
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
