'use strict';

/**
 * DMX fixture profile loader.
 *
 * Usage:
 *   const { loadProfile } = require('./src/dmx/profiles');
 *   const profile = loadProfile('rgb');           // built-in
 *   const profile = loadProfile('custom', {
 *       channels: 'dimmer:1,red:2,green:3,blue:4,white:5'
 *   });
 *
 * Built-in profile names: dimmer, rgb, rgbw, rgba, rgbaw, rgbawuv, par-7ch, mover-basic
 *
 * Custom fixture format (INI key `channels`):
 *   slot:offset[,slot:offset,...]
 *   where offset is 1-based channel offset from the DMX start address.
 *   Offsets must be contiguous starting at 1. Gaps are not allowed.
 *
 * Example:
 *   fixture  = custom
 *   channels = dimmer:1,red:2,green:3,blue:4,white:5
 *
 * Capabilities for custom fixtures are inferred from the channel slots present:
 *   any of red/green/blue     → color
 *   any of white/amber        → colorTemp
 *   dimmer present            → dimmer
 *   strobe present            → strobe
 *   pan present               → pan
 *   tilt present              → tilt
 *   gobo present              → gobo
 *   mode present              → mode
 */

'use strict';

const { validateProfile, VALID_SLOTS } = require('./schema');

// ── Built-in registry ─────────────────────────────────────────────────────

const BUILT_INS = {};

for (const name of [
    'dimmer', 'rgb', 'rgbw', 'rgba', 'rgbaw', 'rgbawuv', 'par-7ch', 'mover-basic',
    'fogger-1ch', 'fogger-2ch', 'strobe-2ch', 'hazer-2ch',
    'mover-8ch', 'mover-12ch',
]) {
    BUILT_INS[name] = require(`./${name}`);
}

// ── Capability inference ──────────────────────────────────────────────────

const SLOT_TO_CAPABILITY = {
    dimmer:  'dimmer',
    red:     'color',
    green:   'color',
    blue:    'color',
    white:   'colorTemp',
    amber:   'colorTemp',
    uv:      'color',
    strobe:  'strobe',
    pan:     'pan',
    tilt:    'tilt',
    gobo:    'gobo',
    mode:    'mode',
    speed:   'mode',
};

function inferCapabilities(channels) {
    const caps = new Set();
    for (const slot of channels) {
        const cap = SLOT_TO_CAPABILITY[slot];
        if (cap) caps.add(cap);
    }
    return [...caps];
}

// ── Custom fixture parser ─────────────────────────────────────────────────

/**
 * Parse a `channels` INI string into an ordered slot array.
 *
 * Format: "slot:offset[,slot:offset,...]"
 * Offsets must be 1-based integers; all offsets 1..N must be present (no gaps).
 *
 * @param {string} raw  — value of the `channels` INI key
 * @returns {string[]}  — ordered slot array (index 0 = offset 1)
 */
function parseCustomChannels(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
        throw new TypeError('custom fixture requires a non-empty `channels` INI key');
    }

    const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (entries.length === 0) {
        throw new TypeError('`channels` must contain at least one slot:offset entry');
    }

    const slotByOffset = {};
    for (const entry of entries) {
        const m = /^([a-z_]+):(\d+)$/i.exec(entry);
        if (!m) {
            throw new TypeError(`Invalid channels entry "${entry}". Expected format: slot:offset (e.g. red:2)`);
        }
        const slot   = m[1].toLowerCase();
        const offset = parseInt(m[2], 10);
        if (!VALID_SLOTS.has(slot)) {
            throw new TypeError(`Unknown slot "${slot}" in custom channels. Valid slots: ${[...VALID_SLOTS].join(', ')}`);
        }
        if (offset < 1) {
            throw new RangeError(`Offset for slot "${slot}" must be >= 1`);
        }
        if (slotByOffset[offset]) {
            throw new TypeError(`Duplicate offset ${offset} in custom channels (slots: "${slotByOffset[offset]}" and "${slot}")`);
        }
        slotByOffset[offset] = slot;
    }

    // Verify contiguous 1..N
    const maxOffset = Math.max(...Object.keys(slotByOffset).map(Number));
    for (let i = 1; i <= maxOffset; i++) {
        if (!slotByOffset[i]) {
            throw new RangeError(`Gap in custom channels: offset ${i} is missing (found offsets up to ${maxOffset})`);
        }
    }

    // Build ordered slot array
    return Array.from({ length: maxOffset }, (_, i) => slotByOffset[i + 1]);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Load a fixture profile by name.
 *
 * @param {string} name    — built-in profile name, or 'custom'
 * @param {object} [opts]  — for 'custom': { channels: string, name?: string }
 * @returns {object}       — validated profile
 */
function loadProfile(name, opts = {}) {
    if (!name || typeof name !== 'string') {
        throw new TypeError('fixture name must be a non-empty string');
    }

    const key = name.toLowerCase();

    if (key === 'custom') {
        const channels    = parseCustomChannels(opts.channels);
        const capabilities = inferCapabilities(channels);
        if (capabilities.length === 0) {
            throw new TypeError('custom fixture channels produce no recognised capabilities');
        }
        return validateProfile({
            name:         opts.name || 'custom',
            channels,
            capabilities,
        });
    }

    const profile = BUILT_INS[key];
    if (!profile) {
        throw new TypeError(
            `Unknown fixture "${name}". Built-in profiles: ${Object.keys(BUILT_INS).join(', ')}. ` +
            `Use fixture = custom with a channels = key for one-off fixtures.`
        );
    }
    return profile;
}

/** Returns a shallow copy of the built-in profile registry (for introspection). */
function listProfiles() {
    return { ...BUILT_INS };
}

module.exports = { loadProfile, listProfiles, parseCustomChannels, inferCapabilities };
