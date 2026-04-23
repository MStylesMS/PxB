'use strict';

/**
 * Z-Wave Notification CC (113) — Access Control notification event values.
 *
 * Reference: Silicon Labs SDS14223 "Notification Command Class"
 *   Value 22 = "Window/Door is open"
 *   Value 23 = "Window/Door is closed"
 *   Value  0 = "Notification idle / clear"
 */
const NOTIFICATION_ACCESS_CONTROL_MAP = {
    22: 'open',
    23: 'close',
    0: 'close',
};

/**
 * Normalize a Z-Wave value-change payload into a contact event token.
 *
 * Handles, in priority order:
 *   1. Notification CC (113) "Access Control" property — values 22/23/0
 *   2. Notification CC (113) other properties — non-zero=open, 0=close
 *   3. Binary Sensor CC (48) — boolean or 0/1
 *   4. Bare boolean values
 *   5. Bare integer values — 0=close, non-zero=open
 *   6. String tokens — 'open'/'close'/'closed' (case-insensitive)
 *
 * Returns null when the value cannot be mapped to a contact token (callers
 * should treat null as "no event to publish").
 *
 * @param {number}          commandClass  - Z-Wave CC number (e.g. 113, 48)
 * @param {string|number}   property      - value property name or key
 * @param {*}               value         - new value from zwave-js
 * @returns {'open'|'close'|null}
 */
function normalizeContact(commandClass, property, value) {
    const propStr = String(property).toLowerCase().trim();

    // --- Notification CC (113) ---
    if (commandClass === 113) {
        if (propStr === 'access control') {
            const n = Number(value);
            return NOTIFICATION_ACCESS_CONTROL_MAP[n] ?? (n === 0 ? 'close' : 'open');
        }
        // Other Notification properties: non-zero = event active (open), 0 = idle (close)
        if (typeof value === 'number') {
            return value === 0 ? 'close' : 'open';
        }
        if (typeof value === 'boolean') {
            return value ? 'open' : 'close';
        }
    }

    // --- Binary Sensor CC (48) ---
    if (commandClass === 48) {
        if (typeof value === 'boolean') return value ? 'open' : 'close';
        const n = Number(value);
        if (!Number.isNaN(n)) return n === 0 ? 'close' : 'open';
    }

    // --- Fallback: bare boolean ---
    if (typeof value === 'boolean') return value ? 'open' : 'close';

    // --- Fallback: bare integer ---
    if (typeof value === 'number') return value === 0 ? 'close' : 'open';

    // --- Fallback: string token ---
    if (typeof value === 'string') {
        const lower = value.toLowerCase().trim();
        if (lower === 'open') return 'open';
        if (lower === 'close' || lower === 'closed') return 'close';
    }

    return null;
}

/**
 * Normalize a Z-Wave Battery CC (128) value-change into a battery percentage.
 *
 * Battery CC property "level" reports 0-100 (with 0xFF = low-battery flag,
 * which zwave-js typically surfaces as 0). Returns null when the value is
 * not a plausible percentage.
 *
 * @param {number}        commandClass
 * @param {string|number} property
 * @param {*}             value
 * @returns {number|null} integer 0-100, or null
 */
function normalizeBattery(commandClass, property, value) {
    if (commandClass !== 128) return null;
    const propStr = String(property).toLowerCase().trim();
    if (propStr !== 'level') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n < 0 || n > 100) return null;
    return Math.round(n);
}

module.exports = { normalizeContact, normalizeBattery, NOTIFICATION_ACCESS_CONTROL_MAP };
