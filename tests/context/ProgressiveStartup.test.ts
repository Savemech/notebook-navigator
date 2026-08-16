/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { describe, expect, it, vi } from 'vitest';
import {
    processProgressiveStartupBatches,
    publishProgressiveStartupReady,
    runDeferredProgressiveStartup,
    runProgressiveStartupStep
} from '../../src/context/storage/progressiveStartup';

describe('progressive startup orchestration', () => {
    it('publishes shell readiness before scheduling background completion', async () => {
        const events: string[] = [];
        let scheduledTask: () => Promise<void> = async () => undefined;
        let resolveBackgroundGate: () => void = () => undefined;
        const backgroundGate = new Promise<void>(resolve => {
            resolveBackgroundGate = resolve;
        });

        publishProgressiveStartupReady({
            markReady: () => events.push('ready'),
            scheduleBackground: task => {
                events.push('scheduled');
                scheduledTask = task;
            },
            isStopped: () => false,
            runBackground: async () => {
                events.push('background-start');
                await backgroundGate;
                events.push('background-complete');
            },
            onBackgroundError: vi.fn()
        });

        expect(events).toEqual(['ready', 'scheduled']);
        const scheduledPromise = scheduledTask();
        await Promise.resolve();
        expect(events).toEqual(['ready', 'scheduled', 'background-start']);

        resolveBackgroundGate();
        await backgroundGate;
        await scheduledPromise;
        expect(events).toEqual(['ready', 'scheduled', 'background-start', 'background-complete']);
    });

    it('prepares navigation trees before publishing storage readiness', () => {
        const events: string[] = [];

        publishProgressiveStartupReady({
            prepareReady: () => events.push('trees-ready'),
            markReady: () => events.push('storage-ready'),
            scheduleBackground: () => events.push('scheduled'),
            isStopped: () => false,
            runBackground: async () => undefined,
            onBackgroundError: vi.fn()
        });

        expect(events).toEqual(['trees-ready', 'storage-ready', 'scheduled']);
    });

    it('captures the current vault snapshot only when deferred work starts', async () => {
        let files = ['before-gate.md'];
        const processed: string[][] = [];
        const deferred = () =>
            runDeferredProgressiveStartup({
                getItems: () => files,
                process: async currentFiles => {
                    processed.push([...currentFiles]);
                }
            });

        files = ['after-gate.md', 'created-during-gate.md'];
        await deferred();

        expect(processed).toEqual([['after-gate.md', 'created-during-gate.md']]);
    });

    it('skips a deferred mutation when teardown occurs during its quiet wait', async () => {
        let stopped = false;
        const run = vi.fn();

        const completed = await runProgressiveStartupStep({
            waitForTurn: async () => {
                stopped = true;
            },
            isStopped: () => stopped,
            run
        });

        expect(completed).toBe(false);
        expect(run).not.toHaveBeenCalled();
    });

    it('does not start deferred background work after shutdown', () => {
        let stopped = false;
        let scheduledTask: () => Promise<void> = async () => undefined;
        const runBackground = vi.fn().mockResolvedValue(undefined);

        publishProgressiveStartupReady({
            markReady: vi.fn(),
            scheduleBackground: task => {
                scheduledTask = task;
            },
            isStopped: () => stopped,
            runBackground,
            onBackgroundError: vi.fn()
        });

        stopped = true;
        void scheduledTask();
        expect(runBackground).not.toHaveBeenCalled();
    });

    it('processes vault discovery in bounded batches with a quiet turn before each batch', async () => {
        const batchSizes: number[] = [];
        const waitForTurn = vi.fn().mockResolvedValue(undefined);

        await processProgressiveStartupBatches({
            items: Array.from({ length: 1_000 }, (_, index) => index),
            batchSize: 128,
            waitForTurn,
            isStopped: () => false,
            processBatch: batch => {
                batchSizes.push(batch.length);
            }
        });

        expect(batchSizes).toEqual([128, 128, 128, 128, 128, 128, 128, 104]);
        expect(waitForTurn).toHaveBeenCalledTimes(8);
    });
});
