'use strict';

const UnavailableOutputAdapter = require('../../../src/adapters/unavailable-output');

describe('UnavailableOutputAdapter', () => {
    let mqttClient;
    let logger;

    beforeEach(() => {
        mqttClient = {
            publish: jest.fn(),
            subscribe: jest.fn((topic, handler) => {
                mqttClient._handler = handler;
            }),
        };

        logger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
    });

    test('subscribes to commands and publishes startup offline warning', async () => {
        const adapter = new UnavailableOutputAdapter({
            config: { topic: 'paradox/houdini/lights/wiz-201' },
            mqttClient,
            logger,
            reason: 'device unreachable',
            label: 'wiz-201',
            backend: 'wiz',
            domain: 'light',
        });

        await adapter.init();

        expect(mqttClient.subscribe).toHaveBeenCalledWith(
            'paradox/houdini/lights/wiz-201/commands',
            expect.any(Function)
        );
        expect(mqttClient.publish).toHaveBeenCalledWith(
            'paradox/houdini/lights/wiz-201/warnings',
            expect.stringContaining('OUTPUT_OFFLINE'),
            { retain: false }
        );
    });

    test('publishes command warning when command is received', async () => {
        const adapter = new UnavailableOutputAdapter({
            config: { topic: 'paradox/houdini/lights/wiz-201' },
            mqttClient,
            logger,
            reason: 'device unreachable',
            label: 'wiz-201',
            backend: 'wiz',
            domain: 'light',
        });

        await adapter.init();
        await adapter.executeCommand({ command: 'setLight' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('rejected command'));
        expect(mqttClient.publish).toHaveBeenCalledWith(
            'paradox/houdini/lights/wiz-201/warnings',
            expect.stringContaining('COMMAND_UNAVAILABLE'),
            { retain: false }
        );
    });
});
