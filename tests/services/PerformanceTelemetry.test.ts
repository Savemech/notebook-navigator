/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BENCHMARK_MODE_ENABLED_KEY,
    finishPhase,
    getPerformanceSnapshot,
    incrementCounter,
    isBenchmarkModeEnabled,
    recordGauge,
    recordHighWater,
    resetPerformanceTelemetry,
    setBenchmarkModeEnabled,
    startPhase,
    trace
} from '../../src/services/diagnostics/PerformanceTelemetry';

describe('PerformanceTelemetry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        setBenchmarkModeEnabled(false);
        resetPerformanceTelemetry();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('is disabled by default and operations are no-ops', () => {
        expect(isBenchmarkModeEnabled()).toBe(false);
        const before = getPerformanceSnapshot();
        expect(before.enabled).toBe(false);
        expect(Object.keys(before.counters)).toHaveLength(0);

        incrementCounter('events');
        recordGauge('queue', 5);
        recordHighWater('queue', 10);
        startPhase('batch');
        finishPhase('batch');
        const finish = trace('task');
        finish();

        const after = getPerformanceSnapshot();
        expect(after.enabled).toBe(false);
        expect(Object.keys(after.counters)).toHaveLength(0);
        expect(Object.keys(after.gauges)).toHaveLength(0);
        expect(Object.keys(after.highWater)).toHaveLength(0);
        expect(Object.keys(after.phaseStats)).toHaveLength(0);
        expect(after.recentEvents).toHaveLength(0);
    });

    it('exposes its localStorage key', () => {
        expect(typeof BENCHMARK_MODE_ENABLED_KEY).toBe('string');
        expect(BENCHMARK_MODE_ENABLED_KEY.length).toBeGreaterThan(0);
    });

    it('tracks counters', () => {
        setBenchmarkModeEnabled(true);
        incrementCounter('events');
        incrementCounter('events', 2);

        const snapshot = getPerformanceSnapshot();
        expect(snapshot.enabled).toBe(true);
        expect(snapshot.counters.events).toBe(3);
    });

    it('tracks gauges and high-water marks', () => {
        setBenchmarkModeEnabled(true);
        recordGauge('queue', 5);
        recordGauge('queue', 3);
        recordHighWater('queue', 4);
        recordHighWater('queue', 6);

        const snapshot = getPerformanceSnapshot();
        expect(snapshot.gauges.queue).toBe(3);
        expect(snapshot.highWater.queue).toBe(6);
    });

    it('resets all metrics and history', () => {
        setBenchmarkModeEnabled(true);
        incrementCounter('events', 5);
        recordGauge('queue', 7);
        recordHighWater('queue', 9);
        startPhase('batch');
        vi.advanceTimersByTime(5);
        finishPhase('batch');

        resetPerformanceTelemetry();
        const snapshot = getPerformanceSnapshot();
        expect(Object.keys(snapshot.counters)).toHaveLength(0);
        expect(Object.keys(snapshot.gauges)).toHaveLength(0);
        expect(Object.keys(snapshot.highWater)).toHaveLength(0);
        expect(Object.keys(snapshot.phaseStats)).toHaveLength(0);
        expect(snapshot.recentEvents).toHaveLength(0);
    });

    it('caps the ring history at 100 events', () => {
        setBenchmarkModeEnabled(true);
        for (let i = 0; i < 150; i++) {
            incrementCounter('ev', i);
        }

        const snapshot = getPerformanceSnapshot();
        expect(snapshot.recentEvents.length).toBe(100);
        expect(snapshot.recentEvents[99]).toMatchObject({ type: 'counter', name: 'ev', value: 149 });
        expect(snapshot.counters.ev).toBe((149 * 150) / 2);
    });

    it('records phase timings', () => {
        vi.useFakeTimers();
        setBenchmarkModeEnabled(true);

        startPhase('batch');
        vi.advanceTimersByTime(10);
        finishPhase('batch');

        const snapshot = getPerformanceSnapshot();
        expect(snapshot.phaseStats.batch.count).toBe(1);
        expect(snapshot.phaseStats.batch.totalMs).toBeGreaterThanOrEqual(10);
        vi.useRealTimers();
    });

    it('deduplicates repeated trace finishes', () => {
        vi.useFakeTimers();
        setBenchmarkModeEnabled(true);

        const finish = trace('task');
        vi.advanceTimersByTime(5);
        finish();
        finish();

        const snapshot = getPerformanceSnapshot();
        expect(snapshot.phaseStats.task.count).toBe(1);
        expect(snapshot.recentEvents.filter(event => event.type === 'phase' && event.name === 'task')).toHaveLength(1);
        vi.useRealTimers();
    });

    it('ignores finishPhase without a matching start', () => {
        setBenchmarkModeEnabled(true);
        finishPhase('orphan');
        const snapshot = getPerformanceSnapshot();
        expect(snapshot.phaseStats.orphan).toBeUndefined();
        expect(snapshot.recentEvents).toHaveLength(0);
    });
});
