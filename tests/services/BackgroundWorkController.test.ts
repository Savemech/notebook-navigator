/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BACKGROUND_INTERACTION_QUIET_MS,
    getRemainingBackgroundQuietTime,
    installForegroundInteractionMonitor,
    recordForegroundInteraction,
    resetBackgroundWorkController,
    waitForBackgroundWorkTurn
} from '../../src/services/content/BackgroundWorkController';

describe('BackgroundWorkController', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        resetBackgroundWorkController();
    });

    afterEach(() => {
        resetBackgroundWorkController();
        vi.useRealTimers();
    });

    it('computes a quiet period after foreground interaction', () => {
        recordForegroundInteraction();

        expect(getRemainingBackgroundQuietTime()).toBe(BACKGROUND_INTERACTION_QUIET_MS);
        vi.advanceTimersByTime(BACKGROUND_INTERACTION_QUIET_MS - 1);
        expect(getRemainingBackgroundQuietTime()).toBe(1);
        vi.advanceTimersByTime(1);
        expect(getRemainingBackgroundQuietTime()).toBe(0);
    });

    it('does not release background work until the interaction quiet period expires', async () => {
        recordForegroundInteraction();
        let released = false;
        const turn = waitForBackgroundWorkTurn().then(() => {
            released = true;
        });

        await vi.advanceTimersByTimeAsync(BACKGROUND_INTERACTION_QUIET_MS - 1);
        expect(released).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await turn;
        expect(released).toBe(true);
    });

    it('extends the quiet period when another interaction arrives', async () => {
        recordForegroundInteraction();
        let released = false;
        const turn = waitForBackgroundWorkTurn().then(() => {
            released = true;
        });

        await vi.advanceTimersByTimeAsync(BACKGROUND_INTERACTION_QUIET_MS - 50);
        recordForegroundInteraction();
        await vi.advanceTimersByTimeAsync(50);
        expect(released).toBe(false);
        await vi.advanceTimersByTimeAsync(BACKGROUND_INTERACTION_QUIET_MS - 50);
        await turn;
        expect(released).toBe(true);
    });

    it('force-admits a bounded background turn during sustained interaction', async () => {
        recordForegroundInteraction();
        let released = false;
        const turn = waitForBackgroundWorkTurn(undefined, 1_000).then(() => {
            released = true;
        });

        for (let elapsed = 0; elapsed < 1_000; elapsed += 250) {
            await vi.advanceTimersByTimeAsync(250);
            recordForegroundInteraction();
        }

        await turn;
        expect(released).toBe(true);
    });

    it('cancels a pending quiet wait without leaving timers behind', async () => {
        recordForegroundInteraction();
        const controller = new AbortController();
        const turn = waitForBackgroundWorkTurn(controller.signal);

        await vi.advanceTimersByTimeAsync(0);
        controller.abort();

        await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('records captured editor input events and removes listeners on cleanup', () => {
        const target = new EventTarget();
        const cleanup = installForegroundInteractionMonitor(target);

        target.dispatchEvent(new Event('keydown'));
        expect(getRemainingBackgroundQuietTime()).toBe(BACKGROUND_INTERACTION_QUIET_MS);

        vi.advanceTimersByTime(BACKGROUND_INTERACTION_QUIET_MS);
        target.dispatchEvent(new Event('wheel'));
        expect(getRemainingBackgroundQuietTime()).toBe(BACKGROUND_INTERACTION_QUIET_MS);

        cleanup();
        vi.advanceTimersByTime(BACKGROUND_INTERACTION_QUIET_MS);
        target.dispatchEvent(new Event('input'));
        expect(getRemainingBackgroundQuietTime()).toBe(0);
    });
});
