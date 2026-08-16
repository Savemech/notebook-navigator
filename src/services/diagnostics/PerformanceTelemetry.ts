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

/**
 * Low-overhead, bounded performance telemetry.
 *
 * All public recording functions are no-ops when benchmark mode is disabled so
 * that normal runtime paths pay only a boolean check and function call. No
 * React or Obsidian APIs are used, keeping the collector usable in unit tests,
 * worker contexts, and pure model scripts.
 */

export const BENCHMARK_MODE_ENABLED_KEY = 'notebook-navigator-benchmark-mode-enabled';

export type TelemetryEventType = 'counter' | 'gauge' | 'highWater' | 'phase';

export interface TelemetryEvent {
    type: TelemetryEventType;
    name: string;
    value: number;
    elapsedMs: number;
}

export interface PhaseStats {
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
    lastMs: number;
}

export interface PerformanceSnapshot {
    enabled: boolean;
    counters: Record<string, number>;
    gauges: Record<string, number>;
    highWater: Record<string, number>;
    phaseStats: Record<string, PhaseStats>;
    recentEvents: TelemetryEvent[];
}

const MAX_HISTORY = 100;

let benchmarkModeEnabled = false;
let epochMs = 0;
let nextPhaseToken = 0;

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const highWaterMarks = new Map<string, number>();
const phaseStats = new Map<string, PhaseStats>();
const activePhases = new Map<string, number>();
const activeTokens = new Set<number>();
const recentEvents: TelemetryEvent[] = [];

function nowMs(): number {
    // Prefer Date.now() so vitest fake timers can control telemetry timing in
    // unit tests. Sub-millisecond resolution is unnecessary for performance
    // telemetry; wall-clock millisecond precision is sufficient and portable.
    return Date.now();
}

function resetTelemetryState(): void {
    counters.clear();
    gauges.clear();
    highWaterMarks.clear();
    phaseStats.clear();
    activePhases.clear();
    activeTokens.clear();
    recentEvents.length = 0;
}

function pushEvent(type: TelemetryEventType, name: string, value: number): void {
    if (recentEvents.length >= MAX_HISTORY) {
        recentEvents.shift();
    }
    recentEvents.push({
        type,
        name,
        value,
        elapsedMs: Math.max(0, nowMs() - epochMs)
    });
}

function accumulatePhase(name: string, elapsedMs: number): void {
    const existing = phaseStats.get(name);
    if (!existing) {
        phaseStats.set(name, {
            count: 1,
            totalMs: elapsedMs,
            minMs: elapsedMs,
            maxMs: elapsedMs,
            lastMs: elapsedMs
        });
    } else {
        existing.count += 1;
        existing.totalMs += elapsedMs;
        existing.minMs = Math.min(existing.minMs, elapsedMs);
        existing.maxMs = Math.max(existing.maxMs, elapsedMs);
        existing.lastMs = elapsedMs;
    }
}

function noop(): void {}

/**
 * Returns whether benchmark telemetry is currently enabled.
 */
export function isBenchmarkModeEnabled(): boolean {
    return benchmarkModeEnabled;
}

/**
 * Enables or disables benchmark telemetry. Disabling resets all collected data
 * so that stale metrics cannot leak across sessions.
 */
export function setBenchmarkModeEnabled(enabled: boolean): void {
    benchmarkModeEnabled = enabled;
    resetTelemetryState();
    epochMs = nowMs();
}

/**
 * Resets all metrics and history while preserving the enabled flag.
 */
export function resetPerformanceTelemetry(): void {
    resetTelemetryState();
    epochMs = nowMs();
}

/**
 * Increments a counter by `delta` (defaults to 1).
 */
export function incrementCounter(name: string, delta = 1): void {
    if (!benchmarkModeEnabled) {
        return;
    }
    counters.set(name, (counters.get(name) ?? 0) + delta);
    pushEvent('counter', name, delta);
}

/**
 * Records the latest value of a gauge.
 */
export function recordGauge(name: string, value: number): void {
    if (!benchmarkModeEnabled) {
        return;
    }
    gauges.set(name, value);
    pushEvent('gauge', name, value);
}

/**
 * Records a high-water mark: the maximum value ever seen for a metric.
 */
export function recordHighWater(name: string, value: number): void {
    if (!benchmarkModeEnabled) {
        return;
    }
    const next = Math.max(highWaterMarks.get(name) ?? 0, value);
    highWaterMarks.set(name, next);
    pushEvent('highWater', name, next);
}

/**
 * Starts a timed phase. Multiple overlapping starts for the same name are
 * collapsed; `finishPhase` finishes the earliest unmatched start.
 */
export function startPhase(name: string): void {
    if (!benchmarkModeEnabled) {
        return;
    }
    if (!activePhases.has(name)) {
        activePhases.set(name, nowMs());
    }
}

/**
 * Finishes a timed phase started with `startPhase`. Repeated calls without a
 * matching start are ignored.
 */
export function finishPhase(name: string): void {
    if (!benchmarkModeEnabled) {
        return;
    }
    const startMs = activePhases.get(name);
    if (startMs === undefined) {
        return;
    }
    activePhases.delete(name);
    const elapsedMs = Math.max(0, nowMs() - startMs);
    accumulatePhase(name, elapsedMs);
    pushEvent('phase', name, elapsedMs);
}

/**
 * Starts a timed phase and returns a finish callback. Repeated calls to the
 * returned callback are deduplicated so a single phase is recorded.
 */
export function trace(name: string): () => void {
    if (!benchmarkModeEnabled) {
        return noop;
    }
    const token = ++nextPhaseToken;
    const startMs = nowMs();
    activeTokens.add(token);
    return () => finishTrace(name, token, startMs);
}

function finishTrace(name: string, token: number, startMs: number): void {
    if (!benchmarkModeEnabled) {
        return;
    }
    if (!activeTokens.has(token)) {
        return;
    }
    activeTokens.delete(token);
    const elapsedMs = Math.max(0, nowMs() - startMs);
    accumulatePhase(name, elapsedMs);
    pushEvent('phase', name, elapsedMs);
}

/**
 * Returns a defensive copy of the current telemetry snapshot.
 */
export function getPerformanceSnapshot(): PerformanceSnapshot {
    return {
        enabled: benchmarkModeEnabled,
        counters: Object.fromEntries(counters),
        gauges: Object.fromEntries(gauges),
        highWater: Object.fromEntries(highWaterMarks),
        phaseStats: Object.fromEntries(phaseStats),
        recentEvents: recentEvents.slice()
    };
}
