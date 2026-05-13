'use strict';

/**
 * Profile schema validator for DMX fixture profiles.
 *
 * A valid profile object must satisfy:
 *   name        {string}   — unique identifier (lowercase, hyphens OK)
 *   channels    {string[]} — ordered slot names, index = channel offset from DMX address (0-based)
 *   capabilities {string[]} — subset of VALID_CAPABILITIES
 *   defaults    {object}   — optional map of slot-name → 0-255 value applied on init / 'on'
 *
 * Slot names carry semantic meaning used by DmxAdapter command handlers:
 *   dimmer  — master intensity (0–255)
 *   red, green, blue, white, amber, uv — colour components
 *   strobe  — strobe rate (0 = off)
 *   mode    — fixture operating mode (value = DMX channel value, fixture-specific)
 *   speed   — macro speed or pan/tilt speed
 *   pan, tilt — moving-head position
 *
 * A profile may list 'mode' in channels to declare a channel that must be set
 * to a specific value to unlock other channels; use defaults to pin that value.
 */

const VALID_CAPABILITIES = new Set([
    'dimmer',
    'color',
    'colorTemp',
    'strobe',
    'pan',
    'tilt',
    'gobo',
    'mode',
    'effect',   // effect devices (fogger, strobe, hazer) — handled by DmxEffectAdapter
]);

const VALID_SLOTS = new Set([
    'dimmer',
    'red', 'green', 'blue', 'white', 'amber', 'uv',
    'strobe',
    'mode',
    'speed',
    'pan', 'tilt',
    'gobo',
]);

/**
 * Validate a profile object. Throws with a descriptive message on failure.
 * @param {object} profile
 * @returns {object} the profile (pass-through if valid)
 */
function validateProfile(profile) {
    if (!profile || typeof profile !== 'object') {
        throw new TypeError('Profile must be a plain object');
    }

    if (typeof profile.name !== 'string' || !profile.name) {
        throw new TypeError('Profile.name must be a non-empty string');
    }

    if (!Array.isArray(profile.channels) || profile.channels.length === 0) {
        throw new TypeError(`Profile "${profile.name}": channels must be a non-empty array`);
    }

    if (profile.channels.length > 512) {
        throw new RangeError(`Profile "${profile.name}": channels length (${profile.channels.length}) exceeds DMX 512-slot maximum`);
    }

    for (const slot of profile.channels) {
        if (typeof slot !== 'string') {
            throw new TypeError(`Profile "${profile.name}": all channel entries must be strings, got ${typeof slot}`);
        }
        if (!VALID_SLOTS.has(slot)) {
            throw new TypeError(`Profile "${profile.name}": unknown channel slot "${slot}". Valid slots: ${[...VALID_SLOTS].join(', ')}`);
        }
    }

    if (!Array.isArray(profile.capabilities) || profile.capabilities.length === 0) {
        throw new TypeError(`Profile "${profile.name}": capabilities must be a non-empty array`);
    }

    for (const cap of profile.capabilities) {
        if (!VALID_CAPABILITIES.has(cap)) {
            throw new TypeError(`Profile "${profile.name}": unknown capability "${cap}". Valid: ${[...VALID_CAPABILITIES].join(', ')}`);
        }
    }

    if (profile.defaults !== undefined) {
        if (typeof profile.defaults !== 'object' || Array.isArray(profile.defaults)) {
            throw new TypeError(`Profile "${profile.name}": defaults must be a plain object`);
        }
        for (const [slot, val] of Object.entries(profile.defaults)) {
            if (!VALID_SLOTS.has(slot)) {
                throw new TypeError(`Profile "${profile.name}": defaults key "${slot}" is not a valid slot`);
            }
            if (typeof val !== 'number' || val < 0 || val > 255 || !Number.isInteger(val)) {
                throw new RangeError(`Profile "${profile.name}": defaults["${slot}"] must be an integer 0–255`);
            }
        }
    }

    return profile;
}

module.exports = { validateProfile, VALID_CAPABILITIES, VALID_SLOTS };
