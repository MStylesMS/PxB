'use strict';

/**
 * Topic builder and retention policy helpers for PxB.
 *
 * All per-node base_topics are operator-defined in INI.
 * Bridge-level topics are derived from mqtt.base_topic.
 */

/**
 * Bridge-level topics under `{baseTopic}/pxb/…`
 */
function bridgeTopics(baseTopic) {
    const root = `${baseTopic}/pxb`;
    return {
        state: `${root}/state`,
        commands: `${root}/commands`,
        warnings: `${root}/warnings`,
        discoveredRoot: `${root}/discovered`,
        discovered: (radio, id) => `${root}/discovered/${radio}/${id}`,
    };
}

/**
 * Per-node topics under the node's own operator-defined base_topic.
 */
function nodeTopics(nodeBaseTopic) {
    return {
        events: `${nodeBaseTopic}/events`,
        state: `${nodeBaseTopic}/state`,
        schema: `${nodeBaseTopic}/schema`,
        commands: `${nodeBaseTopic}/commands`,
        warnings: `${nodeBaseTopic}/warnings`,
    };
}

/**
 * Retention policy lookup.
 * Returns { retain: bool, description: string }
 */
const RETENTION = {
    'pxb/state': { retain: true, description: 'periodic heartbeat' },
    'pxb/commands': { retain: false, description: 'on demand' },
    'pxb/warnings': { retain: false, description: 'on demand' },
    'pxb/discovered': { retain: true, description: 'on discovery' },
    'node/events': { retain: true, description: 'on change only' },
    'node/state': { retain: true, description: 'on telemetry change' },
    'node/schema': { retain: true, description: 'once at startup' },
    'node/commands': { retain: false, description: 'on demand' },
    'node/warnings': { retain: false, description: 'on demand' },
};

module.exports = { bridgeTopics, nodeTopics, RETENTION };
