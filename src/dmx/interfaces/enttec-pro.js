'use strict';

/**
 * EnttecProInterface — Enttec DMX USB Pro output.
 *
 * STATUS: Not implemented. Scheduled for Phase 4.
 *
 * The Enttec USB Pro uses a proprietary packet format (0x7E header) and
 * requires a different serial framing approach than the Open DMX cable.
 * This stub exists so the factory can reject it at startup with a clear
 * actionable error rather than crashing at runtime.
 */
class EnttecProInterface {
    async sendFrame(_devicePath, _frameBuffer) {
        throw new Error(
            'Enttec DMX USB Pro interface is not implemented (Phase 4). ' +
            'Set [dmx] interface = opendmx to use the direct FTDI driver.'
        );
    }
}

module.exports = { EnttecProInterface };
