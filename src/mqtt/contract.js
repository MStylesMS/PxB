'use strict';

/**
 * Topic builder and retention policy helpers for PZB.
 *
 * All per-node base_topics are operator-defined in INI.
 * Bridge-level topics are derived from mqtt.base_topic.
 */

/**
 * Bridge-level topics under `{baseTopic}/pzb/…`
 */
function bridgeTopics(baseTopic) {
    const root = `${baseTopic}/pzb`;
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
        commands: `${nodeBaseTopic}/commands`,
        warnings: `${nodeBaseTopic}/warnings`,
    };
}

/**
 * Retention policy lookup.
 * Returns { retain: bool, description: string }
 */
const RETENTION = {
    'pzb/state': { retain: true, description: 'periodic heartbeat' },
    'pzb/commands': { retain: false, description: 'on demand' },
    'pzb/warnings': { retain: false, description: 'on demand' },
    'pzb/discovered': { retain: true, description: 'on discovery' },
    'node/events': { retain: true, description: 'on change only' },
    'node/state': { retain: true, description: 'on change only' },
    'node/commands': { retain: false, description: 'on demand' },
    'node/warnings': { retain: false, description: 'on demand' },
};

module.exports = { bridgeTopics, nodeTopics, RETENTION };
