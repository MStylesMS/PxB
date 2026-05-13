'use strict';

/**
 * test/soak/fault-isolation.soak.test.js
 *
 * Sustained soak test for PxB fault-isolation machinery.
 *
 * What it tests:
 *   • Five synthetic subsystems (matching the config/test-full-stack.ini layout)
 *     run concurrently, each with a different crash-injection profile.
 *   • The real SubsystemRegistry enforces crash budget, cooling-down, and
 *     quarantine — no mocks of the registry itself.
 *   • Stable subsystems must remain unaffected by their crashing peers.
 *   • SUBSYSTEM_QUARANTINED warnings must be emitted exactly once.
 *   • Crash warnings must stop arriving after quarantine (bounded, no spam).
 *   • Registry size stays constant (no subsystem leaks).
 *
 * Duration: controlled by SOAK_DURATION_MS env var.
 *   5-minute run (default): npm run test:soak
 *   30-minute run:          SOAK_DURATION_MS=1800000 npm run test:soak
 *
 * Crash budget is tuned tight for the soak so full cooling-down → quarantine
 * cycles complete well within 5 minutes:
 *   Window  : 12 s   (production default: 60 s)
 *   Cooldown: 18 s   (production default: 60 s)
 *   Limits  : warn=3, cool=10  (same as production defaults)
 *
 * Crash-injection profiles:
 *   stable   (null)   never crashes
 *   slow     (25 s)   1 crash per 25 s → each in its own fresh window → always contained
 *   moderate (3 s)    4 in 12 s → cooling-down → 4 in next window → quarantine (~42 s)
 *
 * Config fixture: config/test-full-stack.ini
 */

const { SubsystemRegistry } = require('../../src/bridge/subsystem-registry');
const { runInSubsystem }     = require('../../src/bridge/async-context');

// ── Duration ────────────────────────────────────────────────────────────────

const SOAK_DURATION_MS = parseInt(process.env.SOAK_DURATION_MS ?? '300000', 10);
const SOAK_LABEL       = SOAK_DURATION_MS >= 1_800_000 ? '30-minute' : '5-minute';

// ── Crash budget (tuned tight for the soak window) ──────────────────────────

const CRASH_WINDOW_MS  = 12_000;   // sliding window
const CRASH_LIMIT_WARN = 3;        // ≤ this → contained normally
const CRASH_LIMIT_COOL = 10;       // > this in one window → immediate quarantine
const COOLDOWN_MS      = 18_000;   // cooling-down suppression period

// ── Crash-injection rates (ms between injected crashes; null = never) ───────

const RATES = {
    stable:   null,
    slow:     25_000,   // 25 s > 12 s window → always fresh window, always contained
    moderate:  3_000,   // 4 per 12 s → cooldown at ~12 s → quarantine at ~42 s
};

// ── Jest timeout ─────────────────────────────────────────────────────────────

jest.setTimeout(SOAK_DURATION_MS + 60_000);

// ── FakeAdapter ──────────────────────────────────────────────────────────────

/**
 * Simulates a long-lived output adapter registered with SubsystemRegistry.
 *
 * Each instance:
 *   • Registers itself with the real SubsystemRegistry on start().
 *   • Runs a "poll" timer at 500 ms (simulates the adapter's health-check loop).
 *   • Injects synthetic crashes at crashIntervalMs by calling registry.crash()
 *     inside a runInSubsystem() context — the same pathway as a real uncaught
 *     exception that has been attributed to this subsystem.
 */
class FakeAdapter {
    constructor({ id, registry, crashIntervalMs }) {
        this.id              = id;
        this.registry        = registry;
        this.crashIntervalMs = crashIntervalMs;

        this._pollTimer  = null;
        this._crashTimer = null;
        this._tickCount  = 0;
        this._crashCount = 0;
        this.onCrashCalls = [];
    }

    start() {
        this.registry.register({
            id:          this.id,
            kind:        'output-adapter',
            criticality: 'optional',
            onCrash: async (err) => {
                this.onCrashCalls.push({ ts: Date.now(), err });
            },
        });

        // Simulated poll loop.
        this._pollTimer = setInterval(() => { this._tickCount++; }, 500);
        if (this._pollTimer.unref) this._pollTimer.unref();

        // Crash injection.
        if (this.crashIntervalMs) {
            this._crashTimer = setInterval(() => {
                this._crashCount++;
                const err = new Error(`${this.id} synthetic-crash-${this._crashCount}`);
                runInSubsystem(this.id, () => {
                    this.registry.crash(this.id, err).catch(() => {});
                });
            }, this.crashIntervalMs);
            if (this._crashTimer.unref) this._crashTimer.unref();
        }
    }

    stop() {
        clearInterval(this._pollTimer);
        clearInterval(this._crashTimer);
        this._pollTimer  = null;
        this._crashTimer = null;
    }
}

// ── Status helpers ───────────────────────────────────────────────────────────

const STATUS_ICON = {
    ok:           '✓',
    crashed:      '⚡',
    'cooling-down': '❄',
    quarantined:  '✕',
    fatal:        '💀',
};

function buildTransitions(snapshots) {
    const result = {};
    for (const snap of snapshots) {
        for (const [id, status] of Object.entries(snap.summary)) {
            if (!result[id]) result[id] = [];
            const hist = result[id];
            if (hist.length === 0 || hist.at(-1).status !== status) {
                hist.push({ ts: snap.ts, status });
            }
        }
    }
    return result;
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe(`PxB fault-isolation soak (${SOAK_LABEL})`, () => {
    let registry;
    let warnings;
    let adapters;
    let snapshotTimer;
    const snapshots  = [];
    const startTs    = Date.now();

    beforeAll(async () => {
        warnings = [];

        registry = new SubsystemRegistry({
            crashWindowMs:  CRASH_WINDOW_MS,
            crashLimitWarn: CRASH_LIMIT_WARN,
            crashLimitCool: CRASH_LIMIT_COOL,
            cooldownMs:     COOLDOWN_MS,
            publishWarning: (w) => warnings.push({ ts: Date.now(), ...w }),
        });

        // Five adapters matching config/test-full-stack.ini:
        //   hue-mirror       → stable   (Hue adapter, never crashes)
        //   wiz-stage        → stable   (WiZ adapter, never crashes)
        //   lifx-lobby       → moderate (LIFX adapter, crash every 3 s → quarantine ~42 s)
        //   shelly-fogger    → stable   (Shelly switch, never crashes)
        //   light-zone-main  → slow     (zone, crash every 25 s → always contained)
        adapters = {
            'hue-mirror':      new FakeAdapter({ id: 'hue-mirror',      registry, crashIntervalMs: RATES.stable }),
            'wiz-stage':       new FakeAdapter({ id: 'wiz-stage',       registry, crashIntervalMs: RATES.stable }),
            'lifx-lobby':      new FakeAdapter({ id: 'lifx-lobby',      registry, crashIntervalMs: RATES.moderate }),
            'shelly-fogger':   new FakeAdapter({ id: 'shelly-fogger',   registry, crashIntervalMs: RATES.stable }),
            'light-zone-main': new FakeAdapter({ id: 'light-zone-main', registry, crashIntervalMs: RATES.slow }),
        };

        for (const a of Object.values(adapters)) a.start();

        // Snapshot status every 5 s throughout the soak.
        snapshotTimer = setInterval(() => {
            snapshots.push({ ts: Date.now(), summary: { ...registry.getSummary() } });
        }, 5_000);
        // Don't unref — we want every snapshot to land reliably.

        // Run the soak.
        await new Promise((resolve) => setTimeout(resolve, SOAK_DURATION_MS));

        // Give any in-flight registry.crash() promises 200 ms to settle.
        await new Promise((resolve) => setTimeout(resolve, 200));
    }, SOAK_DURATION_MS + 30_000);

    afterAll(() => {
        clearInterval(snapshotTimer);
        for (const a of Object.values(adapters)) {
            a.stop();
            registry.unregister(a.id);
        }
    });

    // ── Printed report ────────────────────────────────────────────────────────

    it('emits a human-readable soak report', () => {
        const final   = registry.getSummary();
        const elapsed = snapshots.length > 1
            ? ((snapshots.at(-1).ts - snapshots[0].ts) / 1000).toFixed(1)
            : '0.0';
        const warn    = (code) => warnings.filter((w) => w.code === code);
        const HR      = '═'.repeat(68);

        console.log('\n');
        console.log(HR);
        console.log(`  PxB Fault-Isolation — ${SOAK_LABEL.toUpperCase()} SOAK REPORT`);
        console.log(`  Elapsed: ${elapsed}s  |  Snapshots: ${snapshots.length}  |  ${new Date().toISOString()}`);
        console.log(HR);

        // Per-adapter final state
        console.log('\n── Final subsystem states ──────────────────────────────────────────');
        for (const [id, status] of Object.entries(final)) {
            const a   = adapters[id];
            const icon = STATUS_ICON[status] ?? '?';
            console.log(
                `  ${id.padEnd(22)} ${icon} ${status.padEnd(14)}` +
                `  onCrash=${String(a.onCrashCalls.length).padEnd(4)}  injected=${a._crashCount}`
            );
        }

        // Warning counts
        console.log('\n── Warning totals ──────────────────────────────────────────────────');
        console.log(`  SUBSYSTEM_CRASH:        ${warn('SUBSYSTEM_CRASH').length}`);
        console.log(`  SUBSYSTEM_QUARANTINED:  ${warn('SUBSYSTEM_QUARANTINED').length}`);

        // Per-quarantined warning detail
        const quarantined = Object.entries(final).filter(([, s]) => s === 'quarantined');
        if (quarantined.length) {
            console.log('\n── Quarantine detail ───────────────────────────────────────────────');
            for (const [id] of quarantined) {
                const qws = warn('SUBSYSTEM_QUARANTINED').filter((w) => w.context?.subsystem_id === id);
                const suppressedAfter = warn('SUBSYSTEM_CRASH').filter((w) =>
                    w.context?.subsystem_id === id &&
                    qws[0] && w.ts > qws[0].ts + 1000
                ).length;
                console.log(
                    `  ${id}:  QUARANTINED warning count=${qws.length}  ` +
                    `crash-warnings-post-quarantine=${suppressedAfter}`
                );
            }
        }

        // Status transitions (only adapters that changed state)
        console.log('\n── Status transitions ──────────────────────────────────────────────');
        const t0 = snapshots[0]?.ts ?? startTs;
        const transitions = buildTransitions(snapshots);
        let anyTransitions = false;
        for (const [id, hist] of Object.entries(transitions)) {
            if (hist.length <= 1) continue;
            anyTransitions = true;
            const line = hist.map((h) =>
                `${STATUS_ICON[h.status] ?? h.status}@+${Math.round((h.ts - t0) / 1000)}s`
            ).join(' → ');
            console.log(`  ${id.padEnd(22)} ${line}`);
        }
        if (!anyTransitions) console.log('  (no transitions observed in snapshot window)');

        console.log(HR);
        console.log('');
    });

    // ── Hard assertions ───────────────────────────────────────────────────────

    it('stable adapters (hue-mirror, wiz-stage, shelly-fogger) stay ok', () => {
        const s = registry.getSummary();
        expect(s['hue-mirror']).toBe('ok');
        expect(s['wiz-stage']).toBe('ok');
        expect(s['shelly-fogger']).toBe('ok');
    });

    it('lifx-lobby (moderate crasher) is quarantined', () => {
        // Expected to quarantine at ~42 s (12 s first window → cooldown 18 s → 12 s second window).
        expect(registry.getSummary()['lifx-lobby']).toBe('quarantined');
    });

    it('light-zone-main (slow crasher) is not quarantined', () => {
        // 25 s crash interval > 12 s window → window always resets → crashCount never
        // accumulates past 1 → never enters cooling-down.
        const status = registry.getSummary()['light-zone-main'];
        expect(['ok', 'crashed']).toContain(status);
    });

    it('SUBSYSTEM_QUARANTINED emitted exactly once per quarantined subsystem', () => {
        const qws = warnings.filter((w) => w.code === 'SUBSYSTEM_QUARANTINED');
        const ids = [...new Set(qws.map((w) => w.context?.subsystem_id))];
        for (const id of ids) {
            const count = qws.filter((w) => w.context?.subsystem_id === id).length;
            expect(count).toBe(1);
        }
    });

    it('crash warnings stop after quarantine (no spam)', () => {
        const qws = warnings.filter((w) => w.code === 'SUBSYSTEM_QUARANTINED');
        for (const qw of qws) {
            const id = qw.context?.subsystem_id;
            if (!id) continue;
            // Allow one window of cleanup after quarantine, then expect silence.
            const postQuarantine = warnings.filter(
                (w) => w.code === 'SUBSYSTEM_CRASH' &&
                       w.context?.subsystem_id === id &&
                       w.ts > qw.ts + CRASH_WINDOW_MS
            );
            expect(postQuarantine).toHaveLength(0);
        }
    });

    it('registry size stays constant throughout (no subsystem leaks)', () => {
        if (snapshots.length < 2) return; // not enough data
        const sizes = snapshots.map((s) => Object.keys(s.summary).length);
        const unique = new Set(sizes);
        expect(unique.size).toBe(1);
        expect(sizes[0]).toBe(Object.keys(adapters).length);
    });
});
