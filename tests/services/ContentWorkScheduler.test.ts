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
import { ContentWorkScheduler, type ContentWorkBudgets, type ContentWorkRequest } from '../../src/services/content/ContentWorkScheduler';

const DEFAULT_BUDGETS: ContentWorkBudgets = {
    activeJobs: 2,
    sourceBytes: 1000,
    decodedPixels: 1_000_000,
    pdfSlots: 1,
    externalSlots: 1
};

function nextTick(): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, 0));
}

function abortError(message = 'The operation was aborted'): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function makeRequest<T = string>(
    overrides: Partial<ContentWorkRequest<T>> & { key: string; execute: ContentWorkRequest<T>['execute'] }
): ContentWorkRequest<T> {
    return {
        priority: 'background',
        weights: {},
        ...overrides
    };
}

describe('ContentWorkScheduler', () => {
    it('runs a single scheduled job and returns its result', async () => {
        const scheduler = new ContentWorkScheduler(DEFAULT_BUDGETS);
        const execute = vi.fn().mockResolvedValue('result');

        const promise = scheduler.schedule(makeRequest({ key: 'a', execute }));

        await expect(promise).resolves.toBe('result');
        expect(execute).toHaveBeenCalledTimes(1);
        const snapshot = scheduler.snapshot();
        expect(snapshot.queued).toBe(0);
        expect(snapshot.running).toBe(0);
    });

    it('admits higher-priority jobs before lower-priority jobs', async () => {
        const scheduler = new ContentWorkScheduler({ ...DEFAULT_BUDGETS, activeJobs: 1 });
        const order: string[] = [];

        const bg = scheduler.schedule(
            makeRequest({
                key: 'bg',
                priority: 'background',
                execute: async () => {
                    order.push('bg');
                }
            })
        );
        const visible = scheduler.schedule(
            makeRequest({
                key: 'visible',
                priority: 'visible',
                execute: async () => {
                    order.push('visible');
                }
            })
        );
        const maintenance = scheduler.schedule(
            makeRequest({
                key: 'maintenance',
                priority: 'maintenance',
                execute: async () => {
                    order.push('maintenance');
                }
            })
        );

        await Promise.all([bg, visible, maintenance]);
        expect(order).toEqual(['visible', 'bg', 'maintenance']);
    });

    it('blocks jobs that exceed concurrent budget weights', async () => {
        const scheduler = new ContentWorkScheduler({ ...DEFAULT_BUDGETS, activeJobs: 1, sourceBytes: 100 });
        const gate = new ResolvableGate();
        const started: string[] = [];
        const finished: string[] = [];

        const heavy = scheduler.schedule(
            makeRequest({
                key: 'heavy',
                priority: 'background',
                weights: { activeJobs: 1, sourceBytes: 100 },
                execute: async () => {
                    started.push('heavy');
                    await gate.wait();
                    finished.push('heavy');
                    return 'heavy-result';
                }
            })
        );

        await nextTick();
        expect(started).toEqual(['heavy']);
        expect(scheduler.snapshot().running).toBe(1);

        const light = scheduler.schedule(
            makeRequest({
                key: 'light',
                priority: 'background',
                weights: { activeJobs: 1, sourceBytes: 1 },
                execute: async () => {
                    started.push('light');
                    finished.push('light');
                    return 'light-result';
                }
            })
        );

        await nextTick();
        expect(started).toEqual(['heavy']);
        expect(scheduler.snapshot().queued).toBe(1);
        expect(scheduler.snapshot().pendingWeights).toMatchObject({ activeJobs: 1, sourceBytes: 1 });

        gate.open();
        await expect(heavy).resolves.toBe('heavy-result');
        await expect(light).resolves.toBe('light-result');
        expect(finished).toEqual(['heavy', 'light']);
    });

    it('reserves budget for a repeatedly bypassed heavy head job', async () => {
        const scheduler = new ContentWorkScheduler(
            { ...DEFAULT_BUDGETS, activeJobs: 2, sourceBytes: 10 },
            { budgetStarvationThreshold: 2 }
        );
        const blockerGate = new ResolvableGate();
        const order: string[] = [];
        const blocker = scheduler.schedule(
            makeRequest({
                key: 'budget-blocker',
                weights: { sourceBytes: 1 },
                execute: async () => {
                    order.push('blocker');
                    await blockerGate.wait();
                }
            })
        );
        await nextTick();

        const heavy = scheduler.schedule(
            makeRequest({
                key: 'reserved-heavy',
                weights: { sourceBytes: 10 },
                execute: async () => {
                    order.push('heavy');
                }
            })
        );
        const small = [1, 2].map(index =>
            scheduler.schedule(
                makeRequest({
                    key: `small-${index}`,
                    weights: { sourceBytes: 1 },
                    execute: async () => {
                        order.push(`small-${index}`);
                    }
                })
            )
        );

        await nextTick();
        await nextTick();
        expect(order).toEqual(['blocker', 'small-1']);

        blockerGate.open();
        await Promise.all([blocker, heavy, ...small]);
        expect(order.indexOf('heavy')).toBeLessThan(order.indexOf('small-2'));
    });

    it('dedups identical keys and shares one execution', async () => {
        const scheduler = new ContentWorkScheduler(DEFAULT_BUDGETS);
        const execute = vi.fn().mockResolvedValue('shared');

        const a = scheduler.schedule(makeRequest({ key: 'same', execute }));
        const b = scheduler.schedule(makeRequest({ key: 'same', execute }));

        await expect(a).resolves.toBe('shared');
        await expect(b).resolves.toBe('shared');
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('promotes priority when a duplicate is submitted with higher priority', async () => {
        // Blocker + 'other' fit together; 'dup' is queued because sourceBytes budget is exhausted.
        const scheduler = new ContentWorkScheduler({
            ...DEFAULT_BUDGETS,
            activeJobs: 2,
            sourceBytes: 100
        });
        const blockerGate = new ResolvableGate();
        const dupGate = new ResolvableGate();
        const order: string[] = [];

        const blocker = scheduler.schedule(
            makeRequest({
                key: 'blocker',
                priority: 'background',
                weights: { sourceBytes: 100 },
                execute: async () => {
                    order.push('blocker');
                    await blockerGate.wait();
                }
            })
        );
        const other = scheduler.schedule(
            makeRequest({
                key: 'other',
                priority: 'visible',
                weights: { sourceBytes: 0 },
                execute: async () => {
                    order.push('other');
                }
            })
        );
        await nextTick();

        const low = scheduler.schedule(
            makeRequest({
                key: 'dup',
                priority: 'background',
                weights: { sourceBytes: 1 },
                execute: async () => {
                    order.push('dup');
                    await dupGate.wait();
                }
            })
        );

        await nextTick();
        expect(order).toEqual(['other', 'blocker']);
        expect(scheduler.snapshot().byPriority.background.queued).toBe(1);

        // Promote 'dup' to visible while it is still queued.
        const high = scheduler.schedule(
            makeRequest({
                key: 'dup',
                priority: 'visible',
                weights: { sourceBytes: 0 },
                execute: undefined as unknown as () => Promise<string>
            })
        );

        await nextTick();
        expect(scheduler.snapshot().byPriority.background.queued).toBe(0);
        expect(scheduler.snapshot().byPriority.visible.queued).toBe(1);

        // When the blocker releases its slot, the promoted job runs before any
        // new lower-priority work would.
        blockerGate.open();
        await nextTick();
        expect(order).toEqual(['other', 'blocker', 'dup']);

        dupGate.open();
        await expect(low).resolves.toBeUndefined();
        await expect(high).resolves.toBeUndefined();
        await Promise.all([blocker, other]);
    });

    it('cancels a queued job when its only subscriber aborts', async () => {
        const scheduler = new ContentWorkScheduler({ ...DEFAULT_BUDGETS, activeJobs: 1 });
        const blockerGate = new ResolvableGate();
        const execute = vi.fn().mockResolvedValue('done');

        const blocker = scheduler.schedule(
            makeRequest({
                key: 'blocker',
                priority: 'background',
                execute: async () => {
                    await blockerGate.wait();
                }
            })
        );
        await nextTick();

        const controller = new AbortController();
        const promise = scheduler.schedule(makeRequest({ key: 'queued', signal: controller.signal, execute }));
        await nextTick();
        expect(scheduler.snapshot().queued).toBe(1);

        controller.abort();
        await expect(promise).rejects.toThrow(/aborted/i);
        expect(execute).not.toHaveBeenCalled();
        expect(scheduler.snapshot().queued).toBe(0);
        expect(scheduler.snapshot().running).toBe(1);

        blockerGate.open();
        await blocker;
    });

    it('cancels a running job when its only subscriber aborts', async () => {
        const scheduler = new ContentWorkScheduler(DEFAULT_BUDGETS);
        const controller = new AbortController();
        const gate = new ResolvableGate();
        let sawAbort = false;

        const promise = scheduler.schedule(
            makeRequest({
                key: 'running',
                signal: controller.signal,
                execute: async signal => {
                    await gate.wait();
                    sawAbort = signal.aborted;
                    if (signal.aborted) {
                        throw abortError();
                    }
                    return 'done';
                }
            })
        );

        await nextTick();
        expect(scheduler.snapshot().running).toBe(1);

        controller.abort();
        gate.open();
        await expect(promise).rejects.toThrow(/aborted/i);
        expect(sawAbort).toBe(true);
        expect(scheduler.snapshot().running).toBe(0);
    });

    it('starts a fresh execution when a cancelled running key is requested again', async () => {
        const scheduler = new ContentWorkScheduler({ ...DEFAULT_BUDGETS, activeJobs: 2 });
        const controller = new AbortController();
        const staleGate = new ResolvableGate();
        const stale = scheduler.schedule(
            makeRequest({
                key: 'reused-key',
                signal: controller.signal,
                execute: async signal => {
                    await staleGate.wait();
                    if (signal.aborted) {
                        throw abortError();
                    }
                    return 'stale';
                }
            })
        );
        await nextTick();

        controller.abort();
        const freshExecute = vi.fn().mockResolvedValue('fresh');
        const fresh = scheduler.schedule(makeRequest({ key: 'reused-key', execute: freshExecute }));

        await expect(fresh).resolves.toBe('fresh');
        expect(freshExecute).toHaveBeenCalledTimes(1);
        staleGate.open();
        await expect(stale).rejects.toThrow(/aborted/i);
    });

    it('keeps a deduped job alive when only one subscriber aborts', async () => {
        const scheduler = new ContentWorkScheduler(DEFAULT_BUDGETS);
        const controllerA = new AbortController();
        const controllerB = new AbortController();
        const gate = new ResolvableGate();
        const execute = vi.fn().mockImplementation(async () => {
            await gate.wait();
            return 'shared';
        });

        const a = scheduler.schedule(makeRequest({ key: 'dup', signal: controllerA.signal, execute }));
        const b = scheduler.schedule(makeRequest({ key: 'dup', signal: controllerB.signal, execute }));

        await nextTick();
        controllerA.abort();
        await expect(a).rejects.toThrow(/aborted/i);

        // Job should still be running for subscriber B.
        expect(execute).toHaveBeenCalledTimes(1);
        gate.open();
        await expect(b).resolves.toBe('shared');
        expect(scheduler.snapshot().running).toBe(0);
    });

    it('rejects jobs whose weight exceeds the total budget in any dimension', async () => {
        const scheduler = new ContentWorkScheduler({ ...DEFAULT_BUDGETS, sourceBytes: 100 });

        const promise = scheduler.schedule(
            makeRequest({
                key: 'too-heavy',
                weights: { sourceBytes: 101 },
                execute: vi.fn()
            })
        );

        await expect(promise).rejects.toMatchObject({ name: 'ContentWorkBudgetError' });
        await expect(promise).rejects.toThrow(/exceeds.*budget/i);
    });

    it('releases all weights after rejection so queued work can start', async () => {
        const scheduler = new ContentWorkScheduler({ ...DEFAULT_BUDGETS, activeJobs: 1, sourceBytes: 10 });
        const failed = scheduler.schedule(
            makeRequest({
                key: 'failed',
                weights: { sourceBytes: 10 },
                execute: async () => {
                    throw new Error('boom');
                }
            })
        );
        const next = scheduler.schedule(makeRequest({ key: 'next', execute: async () => 'next-result' }));

        await expect(failed).rejects.toThrow('boom');
        await expect(next).resolves.toBe('next-result');
        expect(scheduler.snapshot().activeWeights).toEqual({
            activeJobs: 0,
            sourceBytes: 0,
            decodedPixels: 0,
            pdfSlots: 0,
            externalSlots: 0
        });
    });

    it('admits background work within the configured visible-work fairness bound', async () => {
        const scheduler = new ContentWorkScheduler({ ...DEFAULT_BUDGETS, activeJobs: 1 }, { backgroundStarvationThreshold: 2 });
        const order: string[] = [];
        const background = scheduler.schedule(
            makeRequest({
                key: 'background',
                priority: 'background',
                execute: async () => {
                    order.push('background');
                }
            })
        );
        const visible = Array.from({ length: 6 }, (_, index) =>
            scheduler.schedule(
                makeRequest({
                    key: `visible-${index}`,
                    priority: 'visible',
                    execute: async () => {
                        order.push(`visible-${index}`);
                    }
                })
            )
        );

        await Promise.all([background, ...visible]);
        expect(order.indexOf('background')).toBeLessThanOrEqual(2);
    });

    it('rescues the highest-priority waiting class before lower-priority maintenance work', async () => {
        const scheduler = new ContentWorkScheduler({ ...DEFAULT_BUDGETS, activeJobs: 1 }, { backgroundStarvationThreshold: 2 });
        const order: string[] = [];
        const queued = (['selected-folder', 'startup-metadata', 'background', 'maintenance'] as const).map(priority =>
            scheduler.schedule(
                makeRequest({
                    key: priority,
                    priority,
                    execute: async () => {
                        order.push(priority);
                    }
                })
            )
        );
        const visible = Array.from({ length: 6 }, (_, index) =>
            scheduler.schedule(
                makeRequest({
                    key: `fair-visible-${index}`,
                    priority: 'visible',
                    execute: async () => {
                        order.push(`visible-${index}`);
                    }
                })
            )
        );

        await Promise.all([...queued, ...visible]);
        expect(order.indexOf('selected-folder')).toBeLessThanOrEqual(2);
        expect(order.indexOf('selected-folder')).toBeLessThan(order.indexOf('background'));
        expect(order.indexOf('background')).toBeLessThan(order.indexOf('maintenance'));
    });

    it('rescues the oldest waiting lower-priority tier under continuous visible work', async () => {
        const scheduler = new ContentWorkScheduler({ ...DEFAULT_BUDGETS, activeJobs: 1 }, { backgroundStarvationThreshold: 2 });
        const order: string[] = [];
        const background = scheduler.schedule(
            makeRequest({ key: 'old-background', priority: 'background', execute: async () => void order.push('background') })
        );
        const selected = scheduler.schedule(
            makeRequest({ key: 'new-selected', priority: 'selected-folder', execute: async () => void order.push('selected') })
        );
        const visible = Array.from({ length: 6 }, (_, index) =>
            scheduler.schedule(
                makeRequest({
                    key: `oldest-visible-${index}`,
                    priority: 'visible',
                    execute: async () => void order.push(`visible-${index}`)
                })
            )
        );

        await Promise.all([background, selected, ...visible]);
        expect(order.indexOf('background')).toBeLessThanOrEqual(2);
    });

    it('cancels queued and running jobs and drains cooperative work on shutdown', async () => {
        const scheduler = new ContentWorkScheduler({ ...DEFAULT_BUDGETS, activeJobs: 1 });
        const running = scheduler.schedule(
            makeRequest({
                key: 'running-on-shutdown',
                execute: signal =>
                    new Promise((_resolve, reject) => {
                        signal.addEventListener('abort', () => reject(abortError()), { once: true });
                    })
            })
        );
        const queuedExecute = vi.fn().mockResolvedValue('queued');
        const queued = scheduler.schedule(makeRequest({ key: 'queued-on-shutdown', execute: queuedExecute }));
        await nextTick();

        const runningExpectation = expect(running).rejects.toThrow(/aborted/i);
        const queuedExpectation = expect(queued).rejects.toThrow(/aborted/i);
        await scheduler.shutdown();
        await runningExpectation;
        await queuedExpectation;

        expect(queuedExecute).not.toHaveBeenCalled();
        expect(scheduler.snapshot()).toMatchObject({ queued: 0, running: 0, isShutdown: true });
    });

    it('bounds shutdown when running work ignores abort and tolerates its late settle', async () => {
        const scheduler = new ContentWorkScheduler({ ...DEFAULT_BUDGETS, activeJobs: 1 }, { shutdownTimeoutMs: 10 });
        let release: () => void = () => undefined;
        const running = scheduler.schedule(
            makeRequest({
                key: 'non-cooperative-shutdown',
                execute: () =>
                    new Promise<void>(resolve => {
                        release = resolve;
                    })
            })
        );
        await nextTick();

        const runningExpectation = expect(running).rejects.toMatchObject({ name: 'AbortError' });
        await scheduler.shutdown();
        await runningExpectation;
        const zeroWeights = { activeJobs: 0, sourceBytes: 0, decodedPixels: 0, pdfSlots: 0, externalSlots: 0 };
        expect(scheduler.snapshot()).toMatchObject({ queued: 0, running: 0, activeWeights: zeroWeights, isShutdown: true });

        release();
        await nextTick();
        expect(scheduler.snapshot().activeWeights).toEqual(zeroWeights);
    });
});

class ResolvableGate {
    private resolve: (() => void) | null = null;
    private promise: Promise<void> | null = null;

    wait(): Promise<void> {
        if (!this.promise) {
            this.promise = new Promise<void>(resolve => {
                this.resolve = resolve;
            });
        }
        return this.promise;
    }

    open(): void {
        if (this.resolve) {
            this.resolve();
        }
    }
}
