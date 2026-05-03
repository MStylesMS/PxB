'use strict';

const LightZoneAdapter = require('../../../src/lights/zone');

describe('LightZoneAdapter', () => {
    let mockMqtt;
    let mockLogger;

    beforeEach(() => {
        mockMqtt = {
            publish: jest.fn().mockResolvedValue(),
            subscribe: jest.fn((topic, callback) => {
                mockMqtt._commandCallback = callback;
            }),
        };

        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
    });

    test('fans out commands to all member adapters', async () => {
        const memberA = { executeCommand: jest.fn().mockResolvedValue() };
        const memberB = { executeCommand: jest.fn().mockResolvedValue() };
        const adapter = new LightZoneAdapter({
            config: { topic: 'paradox/houdini/lights' },
            mqttClient: mockMqtt,
            logger: mockLogger,
            memberAdapters: new Map([
                ['a', memberA],
                ['b', memberB],
            ]),
        });

        await adapter.init();
        await adapter.executeCommand({ command: 'allOff' });

        expect(memberA.executeCommand).toHaveBeenCalledWith({ command: 'allOff' });
        expect(memberB.executeCommand).toHaveBeenCalledWith({ command: 'allOff' });
    });

    test('continues when a member fails', async () => {
        const memberA = { executeCommand: jest.fn().mockRejectedValue(new Error('member-fail')) };
        const memberB = { executeCommand: jest.fn().mockResolvedValue() };
        const adapter = new LightZoneAdapter({
            config: { topic: 'paradox/houdini/lights' },
            mqttClient: mockMqtt,
            logger: mockLogger,
            memberAdapters: new Map([
                ['a', memberA],
                ['b', memberB],
            ]),
        });

        await adapter.init();
        await adapter.executeCommand({ command: 'allOn' });

        expect(memberA.executeCommand).toHaveBeenCalled();
        expect(memberB.executeCommand).toHaveBeenCalled();
        expect(mockMqtt.publish).toHaveBeenCalledWith(
            expect.stringContaining('/warnings'),
            expect.stringContaining('LIGHT_ZONE_MEMBER_COMMAND_FAILED'),
            expect.any(Object)
        );
    });

    test('throws when all members fail', async () => {
        const memberA = { executeCommand: jest.fn().mockRejectedValue(new Error('member-a-fail')) };
        const memberB = { executeCommand: jest.fn().mockRejectedValue(new Error('member-b-fail')) };
        const adapter = new LightZoneAdapter({
            config: { topic: 'paradox/houdini/lights' },
            mqttClient: mockMqtt,
            logger: mockLogger,
            memberAdapters: new Map([
                ['a', memberA],
                ['b', memberB],
            ]),
        });

        await adapter.init();
        await expect(adapter.executeCommand({ command: 'allOn' })).rejects.toThrow('All light members failed');

        expect(mockMqtt.publish).toHaveBeenCalledWith(
            expect.stringContaining('/warnings'),
            expect.stringContaining('LIGHT_ZONE_ALL_MEMBERS_FAILED'),
            expect.any(Object)
        );
    });

    test('rejects initialization with no members', async () => {
        const adapter = new LightZoneAdapter({
            config: { topic: 'paradox/houdini/lights' },
            mqttClient: mockMqtt,
            logger: mockLogger,
            memberAdapters: new Map(),
        });

        await expect(adapter.init()).rejects.toThrow('at least one member adapter');
    });
});
