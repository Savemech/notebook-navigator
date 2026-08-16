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
import { App } from 'obsidian';
import { ContentProviderRuntime } from '../../src/services/content/ContentProviderRuntime';

describe('ContentProviderRuntime', () => {
    it('shares one registry and provider set across consumers', () => {
        const runtime = new ContentProviderRuntime(new App());
        const first = runtime.acquire();
        const second = runtime.acquire();

        expect(first.registry).toBe(second.registry);
        expect(first.registry.getAllProviders()).toHaveLength(4);
        expect(runtime.getConsumerCount()).toBe(2);

        first.release();
        second.release();
    });

    it('stops providers only after the final idempotent release', () => {
        const runtime = new ContentProviderRuntime(new App());
        const first = runtime.acquire();
        const second = runtime.acquire();
        const stop = vi.spyOn(first.registry, 'stopAllProcessing');

        first.release();
        first.release();
        expect(runtime.getConsumerCount()).toBe(1);
        expect(stop).not.toHaveBeenCalled();

        second.release();
        expect(runtime.getConsumerCount()).toBe(0);
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('drains providers on plugin disposal and rejects future acquisition', () => {
        const runtime = new ContentProviderRuntime(new App());
        const session = runtime.acquire();
        const stop = vi.spyOn(session.registry, 'stopAllProcessing');

        void runtime.dispose();

        expect(stop).toHaveBeenCalledTimes(1);
        expect(runtime.getConsumerCount()).toBe(0);
        expect(() => runtime.acquire()).toThrow('disposed');
        session.release();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('owns one bounded scheduler and shuts it down on plugin disposal', () => {
        const runtime = new ContentProviderRuntime(new App());

        expect(runtime.getSchedulerSnapshot()).toMatchObject({
            queued: 0,
            running: 0,
            activeWeights: { activeJobs: 0 },
            isShutdown: false
        });

        void runtime.dispose();
        expect(runtime.getSchedulerSnapshot().isShutdown).toBe(true);
    });

    it('returns one awaitable disposal promise for shutdown ordering', async () => {
        const runtime = new ContentProviderRuntime(new App());

        const first = runtime.dispose();
        const second = runtime.dispose();

        expect(first).toBeInstanceOf(Promise);
        expect(second).toBe(first);
        await first;
        expect(runtime.getSchedulerSnapshot()).toMatchObject({ queued: 0, running: 0, isShutdown: true });
    });
});
