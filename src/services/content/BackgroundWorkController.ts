/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

export const BACKGROUND_INTERACTION_QUIET_MS = 300;
export const BACKGROUND_MAX_WAIT_MS = 2_000;
const PENDING_INPUT_RETRY_MS = 16;
const FOREGROUND_EVENT_TYPES = ['pointerdown', 'keydown', 'input', 'focusin', 'wheel', 'touchstart', 'touchmove'] as const;

let lastForegroundInteractionMs = Number.NEGATIVE_INFINITY;

function makeAbortError(): Error {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(makeAbortError());
    }
    return new Promise((resolve, reject) => {
        const timerId = window.setTimeout(() => {
            signal?.removeEventListener('abort', handleAbort);
            resolve();
        }, ms);
        const handleAbort = () => {
            window.clearTimeout(timerId);
            signal?.removeEventListener('abort', handleAbort);
            reject(makeAbortError());
        };
        signal?.addEventListener('abort', handleAbort, { once: true });
    });
}

function hasPendingBrowserInput(): boolean {
    if (typeof navigator === 'undefined') {
        return false;
    }
    const scheduling = (navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } }).scheduling;
    try {
        return scheduling?.isInputPending?.() === true;
    } catch {
        return false;
    }
}

export function recordForegroundInteraction(nowMs = Date.now()): void {
    if (!Number.isFinite(nowMs)) {
        return;
    }
    lastForegroundInteractionMs = Math.max(lastForegroundInteractionMs, nowMs);
}

export function getRemainingBackgroundQuietTime(nowMs = Date.now(), quietMs = BACKGROUND_INTERACTION_QUIET_MS): number {
    if (!Number.isFinite(nowMs) || !Number.isFinite(quietMs) || quietMs <= 0) {
        return 0;
    }
    return Math.max(0, quietMs - Math.max(0, nowMs - lastForegroundInteractionMs));
}

/**
 * Gives browser input/timers a macrotask before admitting background work, then waits until
 * the user has been inactive for the quiet window. Repeated input extends the wait.
 */
export async function waitForBackgroundWorkTurn(signal?: AbortSignal, maxWaitMs = BACKGROUND_MAX_WAIT_MS): Promise<void> {
    const startedAt = Date.now();
    await delay(0, signal);

    while (true) {
        const remainingMaxWaitMs = maxWaitMs - (Date.now() - startedAt);
        if (remainingMaxWaitMs <= 0) {
            return;
        }
        const quietRemainingMs = getRemainingBackgroundQuietTime();
        if (quietRemainingMs > 0) {
            await delay(Math.min(quietRemainingMs, remainingMaxWaitMs), signal);
            continue;
        }
        if (hasPendingBrowserInput()) {
            await delay(Math.min(PENDING_INPUT_RETRY_MS, remainingMaxWaitMs), signal);
            continue;
        }
        return;
    }
}

export function installForegroundInteractionMonitor(target: EventTarget): () => void {
    const handleInteraction = () => recordForegroundInteraction();
    const options: AddEventListenerOptions = { capture: true, passive: true };
    FOREGROUND_EVENT_TYPES.forEach(type => target.addEventListener(type, handleInteraction, options));

    return () => {
        FOREGROUND_EVENT_TYPES.forEach(type => target.removeEventListener(type, handleInteraction, options));
    };
}

export function resetBackgroundWorkController(): void {
    lastForegroundInteractionMs = Number.NEGATIVE_INFINITY;
}
