'use strict';

const { Heartbeat } = require('../../src/bridge/heartbeat');

function makeMockMqtt() {
  const published = [];
  return {
    published,
    publish(topic, payload, opts) {
      published.push({ topic, payload, opts });
    },
  };
}

describe('Heartbeat', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('publishes to the correct retained topic on start', () => {
    const mock = makeMockMqtt();
    const hb = new Heartbeat(mock, 'paradox/test', 10, () => ({ state: 'ok', pid: 1 }));
    hb.start();
    expect(mock.published).toHaveLength(1);
    expect(mock.published[0].topic).toBe('paradox/test/pzb/status');
    expect(mock.published[0].opts.retain).toBe(true);
    expect(mock.published[0].payload.state).toBe('ok');
    hb.stop();
  });

  test('publishes again after interval elapses', () => {
    const mock = makeMockMqtt();
    const hb = new Heartbeat(mock, 'paradox/test', 10, () => ({ state: 'ok' }));
    hb.start();
    jest.advanceTimersByTime(10_000);
    expect(mock.published).toHaveLength(2);
    jest.advanceTimersByTime(10_000);
    expect(mock.published).toHaveLength(3);
    hb.stop();
  });

  test('flush() publishes immediately with override', () => {
    const mock = makeMockMqtt();
    const hb = new Heartbeat(mock, 'paradox/test', 10, () => ({ state: 'ok' }));
    hb.start();
    hb.flush({ state: 'stopping' });
    const last = mock.published[mock.published.length - 1];
    expect(last.payload.state).toBe('stopping');
    hb.stop();
  });

  test('stop() prevents further interval publishes', () => {
    const mock = makeMockMqtt();
    const hb = new Heartbeat(mock, 'paradox/test', 10, () => ({ state: 'ok' }));
    hb.start();
    hb.stop();
    jest.advanceTimersByTime(30_000);
    expect(mock.published).toHaveLength(1); // only initial publish
  });
});
