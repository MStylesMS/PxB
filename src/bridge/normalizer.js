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
 *   2. Binary Sensor CC (48) — boolean or 0/1
 *   3. Bare boolean values
 *   4. Bare integer values — 0=close, non-zero=open
 *   5. String tokens — 'open'/'close'/'closed' (case-insensitive)
 *
 * IMPORTANT: For Notification CC (113), only the `Access Control` property
 * is honored. Legacy `alarmType` / `alarmLevel` and other notification
 * sub-properties are ignored (return null) because Z-Wave devices such as
 * the Zooz ZSE41 emit a zero-valued `alarmType` / `alarmLevel` reset frame
 * immediately before the real `Access Control` report. Treating those as
 * close events produces a phantom close → open burst on every first
 * actuation after driver start or a long idle period.
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
    // Only Access Control drives the contact signal. Other CC 113 properties
    // (alarmType, alarmLevel, Burglar, etc.) are ignored — see note above.
    if (commandClass === 113) {
        if (propStr === 'access control') {
            const n = Number(value);
            return NOTIFICATION_ACCESS_CONTROL_MAP[n] ?? (n === 0 ? 'close' : 'open');
        }
        return null;
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

/**
 * Normalize a Zigbee `message` event into a contact event token.
 *
 * Handled inputs (from `zigbee-herdsman` message events):
 *
 *   1. IAS Zone cluster (`ssIasZone`):
 *      - `commandStatusChangeNotification` with `data.zonestatus` — bit 0
 *        (`alarm1`) = open; 0 = closed.
 *      - `attributeReport` with `data.zoneStatus` — same bit semantics.
 *   2. On/Off cluster (`genOnOff`) `attributeReport` with `data.onOff` —
 *      mostly used for relay/switch echo but returns `'open'`/`'close'` so
 *      contact-style devices reporting via genOnOff also work.
 *
 * Returns null when the value cannot be mapped.
 *
 * @param {string} cluster   - herdsman cluster name (e.g. 'ssIasZone', 'genOnOff')
 * @param {string} type      - message type (e.g. 'attributeReport', 'commandStatusChangeNotification')
 * @param {object} data      - herdsman message payload
 * @returns {'open'|'close'|null}
 */
function normalizeZigbeeContact(cluster, type, data) {
    if (!cluster || !data || typeof data !== 'object') return null;

    if (cluster === 'ssIasZone') {
        const zoneStatus = data.zonestatus ?? data.zoneStatus;
        if (typeof zoneStatus === 'number') {
            // bit 0 = alarm1 (Open/Alarm), bit 1 = alarm2. Either set → open.
            return (zoneStatus & 0x03) ? 'open' : 'close';
        }
        return null;
    }

    if (cluster === 'genOnOff') {
        if (typeof data.onOff === 'number' || typeof data.onOff === 'boolean') {
            return data.onOff ? 'open' : 'close';
        }
        return null;
    }

    return null;
}

/**
 * Normalize a Zigbee battery attribute report.
 *
 * Handles `genPowerCfg` cluster `batteryPercentageRemaining` where values are
 * in 0.5% units (0–200 → 0–100%). Returns an integer 0–100 or null.
 */
function normalizeZigbeeBattery(cluster, type, data) {
    if (cluster !== 'genPowerCfg' || !data || typeof data !== 'object') return null;
    const raw = data.batteryPercentageRemaining;
    if (typeof raw !== 'number') return null;
    const pct = Math.round(raw / 2);
    if (pct < 0 || pct > 100) return null;
    return pct;
}

module.exports = {
    normalizeContact,
    normalizeBattery,
    normalizeZigbeeContact,
    normalizeZigbeeBattery,
    NOTIFICATION_ACCESS_CONTROL_MAP,
};
