'use strict';

const {
    normalizeZigbeeContact,
    normalizeZigbeeBattery,
} = require('../../src/bridge/normalizer');

describe('normalizeZigbeeContact: ssIasZone', () => {
    test('zonestatus bit 0 set → open', () => {
        expect(normalizeZigbeeContact('ssIasZone', 'commandStatusChangeNotification', { zonestatus: 0x01 })).toBe('open');
    });
    test('zonestatus bit 1 set → open', () => {
        expect(normalizeZigbeeContact('ssIasZone', 'commandStatusChangeNotification', { zonestatus: 0x02 })).toBe('open');
    });
    test('zonestatus = 0 → close', () => {
        expect(normalizeZigbeeContact('ssIasZone', 'commandStatusChangeNotification', { zonestatus: 0x00 })).toBe('close');
    });
    test('camelCase zoneStatus also accepted', () => {
        expect(normalizeZigbeeContact('ssIasZone', 'attributeReport', { zoneStatus: 0x01 })).toBe('open');
    });
    test('missing zonestatus → null', () => {
        expect(normalizeZigbeeContact('ssIasZone', 'attributeReport', {})).toBeNull();
    });
});

describe('normalizeZigbeeContact: genOnOff', () => {
    test('onOff=1 → open', () => {
        expect(normalizeZigbeeContact('genOnOff', 'attributeReport', { onOff: 1 })).toBe('open');
    });
    test('onOff=0 → close', () => {
        expect(normalizeZigbeeContact('genOnOff', 'attributeReport', { onOff: 0 })).toBe('close');
    });
    test('onOff=true → open', () => {
        expect(normalizeZigbeeContact('genOnOff', 'attributeReport', { onOff: true })).toBe('open');
    });
});

describe('normalizeZigbeeContact: unknown clusters → null', () => {
    test('genBasic returns null', () => {
        expect(normalizeZigbeeContact('genBasic', 'attributeReport', {})).toBeNull();
    });
    test('missing data → null', () => {
        expect(normalizeZigbeeContact('ssIasZone', 'x', null)).toBeNull();
    });
});

describe('normalizeZigbeeBattery', () => {
    test('genPowerCfg batteryPercentageRemaining 200 → 100', () => {
        expect(normalizeZigbeeBattery('genPowerCfg', 'attributeReport', { batteryPercentageRemaining: 200 })).toBe(100);
    });
    test('100 → 50', () => {
        expect(normalizeZigbeeBattery('genPowerCfg', 'attributeReport', { batteryPercentageRemaining: 100 })).toBe(50);
    });
    test('0 → 0', () => {
        expect(normalizeZigbeeBattery('genPowerCfg', 'attributeReport', { batteryPercentageRemaining: 0 })).toBe(0);
    });
    test('out-of-range returns null', () => {
        expect(normalizeZigbeeBattery('genPowerCfg', 'attributeReport', { batteryPercentageRemaining: 250 })).toBeNull();
    });
    test('different cluster returns null', () => {
        expect(normalizeZigbeeBattery('genOnOff', 'attributeReport', { batteryPercentageRemaining: 100 })).toBeNull();
    });
});
