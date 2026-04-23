'use strict';

const { normalizeContact, NOTIFICATION_ACCESS_CONTROL_MAP } = require('../../src/bridge/normalizer');

describe('normalizeContact: Notification CC (113) — Access Control', () => {
    test('value 22 → open', () => {
        expect(normalizeContact(113, 'Access Control', 22)).toBe('open');
    });
    test('value 23 → close', () => {
        expect(normalizeContact(113, 'Access Control', 23)).toBe('close');
    });
    test('value 0 (idle) → close', () => {
        expect(normalizeContact(113, 'Access Control', 0)).toBe('close');
    });
    test('property name is case-insensitive', () => {
        expect(normalizeContact(113, 'access control', 22)).toBe('open');
        expect(normalizeContact(113, 'ACCESS CONTROL', 23)).toBe('close');
    });
    test('unknown positive value → open (generic notification)', () => {
        expect(normalizeContact(113, 'Access Control', 99)).toBe('open');
    });
});

describe('normalizeContact: Notification CC (113) — other properties ignored', () => {
    // Legacy alarmType / alarmLevel reset frames precede real Access Control
    // reports on devices like the Zooz ZSE41 and must not drive the contact
    // signal. Any non-Access-Control CC 113 property returns null.
    test('alarmType value is ignored', () => {
        expect(normalizeContact(113, 'alarmType', 0)).toBeNull();
        expect(normalizeContact(113, 'alarmType', 7)).toBeNull();
    });
    test('alarmLevel value is ignored', () => {
        expect(normalizeContact(113, 'alarmLevel', 0)).toBeNull();
        expect(normalizeContact(113, 'alarmLevel', 1)).toBeNull();
    });
    test('Burglar notification is ignored (not a contact signal)', () => {
        expect(normalizeContact(113, 'Burglar', 7)).toBeNull();
        expect(normalizeContact(113, 'Burglar', 0)).toBeNull();
    });
    test('unknown CC 113 property with boolean is ignored', () => {
        expect(normalizeContact(113, 'Something', true)).toBeNull();
        expect(normalizeContact(113, 'Something', false)).toBeNull();
    });
});

describe('normalizeContact: Binary Sensor CC (48)', () => {
    test('true → open', () => {
        expect(normalizeContact(48, 'Any', true)).toBe('open');
    });
    test('false → close', () => {
        expect(normalizeContact(48, 'Any', false)).toBe('close');
    });
    test('1 → open', () => {
        expect(normalizeContact(48, 'Any', 1)).toBe('open');
    });
    test('0 → close', () => {
        expect(normalizeContact(48, 'Any', 0)).toBe('close');
    });
});

describe('normalizeContact: fallback handling', () => {
    test('bare boolean true → open', () => {
        expect(normalizeContact(999, 'x', true)).toBe('open');
    });
    test('bare boolean false → close', () => {
        expect(normalizeContact(999, 'x', false)).toBe('close');
    });
    test('bare integer 1 → open', () => {
        expect(normalizeContact(999, 'x', 1)).toBe('open');
    });
    test('bare integer 0 → close', () => {
        expect(normalizeContact(999, 'x', 0)).toBe('close');
    });
    test('string "open" → open', () => {
        expect(normalizeContact(999, 'x', 'open')).toBe('open');
    });
    test('string "Open" (mixed case) → open', () => {
        expect(normalizeContact(999, 'x', 'Open')).toBe('open');
    });
    test('string "close" → close', () => {
        expect(normalizeContact(999, 'x', 'close')).toBe('close');
    });
    test('string "closed" → close', () => {
        expect(normalizeContact(999, 'x', 'closed')).toBe('close');
    });
    test('unrecognized string → null', () => {
        expect(normalizeContact(999, 'x', 'banana')).toBeNull();
    });
    test('null value → null', () => {
        expect(normalizeContact(999, 'x', null)).toBeNull();
    });
    test('undefined value → null', () => {
        expect(normalizeContact(999, 'x', undefined)).toBeNull();
    });
    test('object value → null', () => {
        expect(normalizeContact(999, 'x', {})).toBeNull();
    });
});

describe('NOTIFICATION_ACCESS_CONTROL_MAP', () => {
    test('has expected keys', () => {
        expect(NOTIFICATION_ACCESS_CONTROL_MAP[22]).toBe('open');
        expect(NOTIFICATION_ACCESS_CONTROL_MAP[23]).toBe('close');
        expect(NOTIFICATION_ACCESS_CONTROL_MAP[0]).toBe('close');
    });
});
