/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

export interface ProgressiveStartupReadyOptions {
    prepareReady?: () => void;
    markReady: () => void;
    scheduleBackground: (task: () => Promise<void>) => void;
    isStopped: () => boolean;
    runBackground: () => Promise<void>;
    onBackgroundError: (error: unknown) => void;
}

export interface DeferredProgressiveStartupOptions<T> {
    getItems: () => T[];
    process: (items: T[]) => Promise<void>;
}

export async function runDeferredProgressiveStartup<T>({ getItems, process }: DeferredProgressiveStartupOptions<T>): Promise<void> {
    const items = getItems();
    await process(items);
}

export async function runProgressiveStartupStep({
    waitForTurn,
    isStopped,
    run
}: {
    waitForTurn: () => Promise<void>;
    isStopped: () => boolean;
    run: () => void | Promise<void>;
}): Promise<boolean> {
    if (isStopped()) {
        return false;
    }
    await waitForTurn();
    if (isStopped()) {
        return false;
    }
    await run();
    return true;
}

export interface ProgressiveStartupBatchOptions<T> {
    items: readonly T[];
    batchSize: number;
    waitForTurn: () => Promise<void>;
    isStopped: () => boolean;
    processBatch: (batch: readonly T[]) => Promise<void> | void;
}

export async function processProgressiveStartupBatches<T>({
    items,
    batchSize,
    waitForTurn,
    isStopped,
    processBatch
}: ProgressiveStartupBatchOptions<T>): Promise<void> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new RangeError('Progressive startup batchSize must be a positive integer');
    }
    for (let offset = 0; offset < items.length; offset += batchSize) {
        if (isStopped()) {
            return;
        }
        await waitForTurn();
        if (isStopped()) {
            return;
        }
        await processBatch(items.slice(offset, offset + batchSize));
    }
}

/**
 * Publishes the minimal storage/list shell before any derived-content or
 * navigation-tree work begins. The caller owns the scheduling primitive so
 * browser startup can use the foreground quiet gate while tests stay
 * deterministic.
 */
export function publishProgressiveStartupReady({
    prepareReady,
    markReady,
    scheduleBackground,
    isStopped,
    runBackground,
    onBackgroundError
}: ProgressiveStartupReadyOptions): void {
    if (isStopped()) {
        return;
    }
    prepareReady?.();
    if (isStopped()) {
        return;
    }
    markReady();
    scheduleBackground(async () => {
        if (isStopped()) {
            return;
        }
        try {
            await runBackground();
        } catch (error: unknown) {
            onBackgroundError(error);
        }
    });
}
