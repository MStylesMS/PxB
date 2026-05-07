'use strict';

const { bridgeTopics, nodeTopics } = require('../../src/mqtt/contract');

describe('bridgeTopics', () => {
  const bt = bridgeTopics('paradox/houdini');

  test('state topic', () => expect(bt.state).toBe('paradox/houdini/pxb/state'));
  test('commands topic', () => expect(bt.commands).toBe('paradox/houdini/pxb/commands'));
  test('warnings topic', () => expect(bt.warnings).toBe('paradox/houdini/pxb/warnings'));
  test('discoveredRoot',  () => expect(bt.discoveredRoot).toBe('paradox/houdini/pxb/discovered'));
  test('discovered()', () => expect(bt.discovered('zwave', 3)).toBe('paradox/houdini/pxb/discovered/zwave/3'));
});

describe('nodeTopics', () => {
  const nt = nodeTopics('paradox/houdini/zwave/spell-box');

  test('events', ()   => expect(nt.events).toBe('paradox/houdini/zwave/spell-box/events'));
  test('state', ()    => expect(nt.state).toBe('paradox/houdini/zwave/spell-box/state'));
  test('schema', ()   => expect(nt.schema).toBe('paradox/houdini/zwave/spell-box/schema'));
  test('commands', () => expect(nt.commands).toBe('paradox/houdini/zwave/spell-box/commands'));
  test('warnings', () => expect(nt.warnings).toBe('paradox/houdini/zwave/spell-box/warnings'));
});
