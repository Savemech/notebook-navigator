/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Priority levels for content work.
 *
 * Higher items are admitted before lower items when slots are available.
 */
export type ContentWorkPriority = 'visible' | 'selected-folder' | 'startup-metadata' | 'background' | 'maintenance';

/**
 * Resource weights a single job consumes while running.
 *
 * `activeJobs` defaults to 1; the rest default to 0.
 */
export interface ContentWorkWeights {
    activeJobs?: number;
    sourceBytes?: number;
    decodedPixels?: number;
    pdfSlots?: number;
    externalSlots?: number;
}

/**
 * Total resource budgets the scheduler enforces concurrently.
 */
export interface ContentWorkBudgets {
    activeJobs: number;
    sourceBytes: number;
    decodedPixels: number;
    pdfSlots: number;
    externalSlots: number;
}

/**
 * Request submitted to the scheduler.
 */
export interface ContentWorkRequest<T> {
    /** Dedup key: path + provider + expected content key. */
    key: string;
    priority: ContentWorkPriority;
    weights: ContentWorkWeights;
    /** Optional caller signal. The job cancels only when all subscribers abort. */
    signal?: AbortSignal;
    /** Work function. Receives the scheduler's internal signal. */
    execute: (signal: AbortSignal) => Promise<T> | T;
}

/**
 * Inspectable scheduler state.
 */
export interface ContentWorkSnapshot {
    queued: number;
    running: number;
    byPriority: Record<ContentWorkPriority, { queued: number; running: number }>;
    activeWeights: ContentWorkBudgets;
    pendingWeights: ContentWorkBudgets;
    isShutdown: boolean;
}

export const CONTENT_WORK_PRIORITY_ORDER: readonly ContentWorkPriority[] = [
    'visible',
    'selected-folder',
    'startup-metadata',
    'background',
    'maintenance'
];

const DEFAULT_WEIGHTS: Required<ContentWorkWeights> = {
    activeJobs: 1,
    sourceBytes: 0,
    decodedPixels: 0,
    pdfSlots: 0,
    externalSlots: 0
};

const BUDGET_KEYS: (keyof ContentWorkBudgets)[] = ['activeJobs', 'sourceBytes', 'decodedPixels', 'pdfSlots', 'externalSlots'];

function normalizeWeights(weights: ContentWorkWeights): Required<ContentWorkWeights> {
    return {
        activeJobs: Math.max(0, weights.activeJobs ?? DEFAULT_WEIGHTS.activeJobs),
        sourceBytes: Math.max(0, weights.sourceBytes ?? DEFAULT_WEIGHTS.sourceBytes),
        decodedPixels: Math.max(0, weights.decodedPixels ?? DEFAULT_WEIGHTS.decodedPixels),
        pdfSlots: Math.max(0, weights.pdfSlots ?? DEFAULT_WEIGHTS.pdfSlots),
        externalSlots: Math.max(0, weights.externalSlots ?? DEFAULT_WEIGHTS.externalSlots)
    };
}

function makeAbortError(message = 'The operation was aborted'): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function makeBudgetError(message: string): Error {
    const error = new RangeError(message);
    error.name = 'ContentWorkBudgetError';
    return error;
}

interface Subscriber<T> {
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal | undefined;
    abortHandler: (() => void) | undefined;
    cancelled: boolean;
}

interface DedupedJob {
    key: string;
    priority: ContentWorkPriority;
    weights: Required<ContentWorkWeights>;
    controller: AbortController;
    subscribers: Subscriber<unknown>[];
    started: boolean;
    running: boolean;
    settled: boolean;
    execute: (signal: AbortSignal) => unknown;
    resultPromise: Promise<unknown> | null;
    budgetSkipCount: number;
    sequence: number;
}

/**
 * Priority-aware, budget-limited work scheduler for content providers.
 *
 * - One deduped job per key; multiple callers share the same execution.
 * - Priority promotion on duplicate submissions.
 * - Subscriber-aware cancellation: cancelling one duplicate caller does not
 *   abort work still needed by another subscriber.
 * - Weighted budgets gate concurrency (active jobs, bytes, pixels, PDF slots,
 *   external-request slots).
 * - Bounded fairness prevents background/maintenance starvation.
 * - Shutdown cancels queued work, aborts running work, and drains cooperative
 *   jobs before resolving.
 */
export class ContentWorkScheduler {
    private readonly budgets: ContentWorkBudgets;
    private readonly queues = new Map<ContentWorkPriority, DedupedJob[]>();
    private readonly jobsByKey = new Map<string, DedupedJob>();
    private activeWeights: ContentWorkBudgets = {
        activeJobs: 0,
        sourceBytes: 0,
        decodedPixels: 0,
        pdfSlots: 0,
        externalSlots: 0
    };
    private pendingWeights: ContentWorkBudgets = {
        activeJobs: 0,
        sourceBytes: 0,
        decodedPixels: 0,
        pdfSlots: 0,
        externalSlots: 0
    };
    private running = new Set<DedupedJob>();
    private isShutdown = false;
    private backgroundStarvationCounter = 0;
    private readonly backgroundStarvationThreshold: number;
    private readonly budgetStarvationThreshold: number;
    private readonly shutdownTimeoutMs: number;
    private shutdownPromise: Promise<void> | null = null;
    private shutdownResolver: (() => void) | null = null;
    private drainCycleScheduled = false;
    private nextSequence = 0;

    constructor(
        budgets: ContentWorkBudgets,
        options?: { backgroundStarvationThreshold?: number; budgetStarvationThreshold?: number; shutdownTimeoutMs?: number }
    ) {
        this.budgets = { ...budgets };
        this.backgroundStarvationThreshold = options?.backgroundStarvationThreshold ?? 5;
        this.budgetStarvationThreshold = Math.max(1, options?.budgetStarvationThreshold ?? 5);
        this.shutdownTimeoutMs = Math.max(0, options?.shutdownTimeoutMs ?? 250);
        for (const priority of CONTENT_WORK_PRIORITY_ORDER) {
            this.queues.set(priority, []);
        }
    }

    /**
     * Schedules work.
     *
     * If another caller has already submitted the same key, this call joins
     * the existing job, promotes its priority if needed, and returns a separate
     * promise. Cancelling this request only cancels the shared job when the
     * last subscriber aborts.
     */
    schedule<T>(request: ContentWorkRequest<T>): Promise<T> {
        const weights = normalizeWeights(request.weights);

        for (const key of BUDGET_KEYS) {
            if (weights[key] > this.budgets[key]) {
                return Promise.reject(makeBudgetError(`Job weight ${key} (${weights[key]}) exceeds total budget (${this.budgets[key]})`));
            }
        }

        if (this.isShutdown) {
            return Promise.reject(makeAbortError('Scheduler is shutdown'));
        }

        if (request.signal?.aborted) {
            return Promise.reject(makeAbortError());
        }

        const existing = this.jobsByKey.get(request.key);
        if (existing) {
            return this.attachToJob<T>(existing, request);
        }

        const controller = new AbortController();
        const job: DedupedJob = {
            key: request.key,
            priority: request.priority,
            weights,
            controller,
            subscribers: [],
            started: false,
            running: false,
            settled: false,
            execute: request.execute,
            resultPromise: null,
            budgetSkipCount: 0,
            sequence: this.nextSequence++
        };

        this.jobsByKey.set(job.key, job);
        this.enqueue(job);

        const promise = this.attachToJob<T>(job, request);
        this.updatePendingWeights();
        this.scheduleDrain();
        return promise;
    }

    /**
     * Returns an inspectable snapshot of scheduler state.
     */
    snapshot(): ContentWorkSnapshot {
        const byPriority = {} as Record<ContentWorkPriority, { queued: number; running: number }>;
        for (const priority of CONTENT_WORK_PRIORITY_ORDER) {
            byPriority[priority] = { queued: 0, running: 0 };
        }

        let queued = 0;
        let running = 0;

        for (const job of this.jobsByKey.values()) {
            if (!job.started && !job.settled) {
                const entry = byPriority[job.priority];
                entry.queued += 1;
                queued += 1;
            }
        }
        for (const job of this.running) {
            byPriority[job.priority].running += 1;
            running += 1;
        }

        return {
            queued,
            running,
            byPriority,
            activeWeights: { ...this.activeWeights },
            pendingWeights: { ...this.pendingWeights },
            isShutdown: this.isShutdown
        };
    }

    /**
     * Cancels all queued work, aborts all running work, and resolves once
     * every cooperative job has released its weights and settled.
     */
    shutdown(): Promise<void> {
        if (this.shutdownPromise) {
            return this.shutdownPromise;
        }
        this.isShutdown = true;

        for (const job of this.jobsByKey.values()) {
            if (!job.settled) {
                job.controller.abort();
            }
        }

        if (this.running.size === 0) {
            this.rejectAllQueued();
            this.shutdownPromise = Promise.resolve();
            return this.shutdownPromise;
        }

        this.shutdownPromise = new Promise(resolve => {
            const timeoutId = window.setTimeout(() => {
                for (const job of [...this.running]) {
                    this.settleRunningJob(job, makeAbortError('Scheduler shutdown timed out'), true);
                }
                resolve();
            }, this.shutdownTimeoutMs);
            this.shutdownResolver = () => {
                window.clearTimeout(timeoutId);
                resolve();
            };
        });
        this.rejectAllQueued();
        return this.shutdownPromise;
    }

    private attachToJob<T>(job: DedupedJob, request: ContentWorkRequest<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const subscriber: Subscriber<T> = {
                resolve,
                reject,
                signal: request.signal,
                abortHandler: undefined,
                cancelled: false
            };

            const handleAbort = () => {
                if (request.signal) {
                    request.signal.removeEventListener('abort', handleAbort);
                }
                this.removeSubscriber(job, subscriber as Subscriber<unknown>);
            };

            if (request.signal) {
                subscriber.abortHandler = handleAbort;
                request.signal.addEventListener('abort', handleAbort, { once: true });
            }

            job.subscribers.push(subscriber as Subscriber<unknown>);

            // Priority promotion on duplicate.
            const newPriority = request.priority;
            if (CONTENT_WORK_PRIORITY_ORDER.indexOf(newPriority) < CONTENT_WORK_PRIORITY_ORDER.indexOf(job.priority)) {
                this.promoteJobPriority(job, newPriority);
            }

            // If the job already settled, fulfill this subscriber immediately.
            if (job.settled) {
                // This path should not normally be hit because we don't keep
                // settled jobs in jobsByKey, but guard for safety.
                if (job.controller.signal.aborted) {
                    reject(makeAbortError());
                } else if (job.resultPromise) {
                    job.resultPromise.then(
                        value => resolve(value as T),
                        error => reject(error instanceof Error ? error : new Error(String(error)))
                    );
                }
            }
        });
    }

    private removeSubscriber(job: DedupedJob, subscriber: Subscriber<unknown>): void {
        const index = job.subscribers.indexOf(subscriber);
        if (index < 0) {
            return;
        }

        if (!subscriber.cancelled) {
            subscriber.cancelled = true;
            subscriber.reject(makeAbortError());
        }
        job.subscribers.splice(index, 1);

        if (job.subscribers.length === 0 && !job.settled) {
            job.controller.abort();
            if (this.jobsByKey.get(job.key) === job) {
                this.jobsByKey.delete(job.key);
            }
            if (!job.started) {
                this.removeFromQueue(job);
                this.updatePendingWeights();
            }
        }
    }

    private promoteJobPriority(job: DedupedJob, newPriority: ContentWorkPriority): void {
        if (job.started || job.settled) {
            return;
        }
        this.removeFromQueue(job);
        job.priority = newPriority;
        this.enqueue(job);
        this.updatePendingWeights();
        this.scheduleDrain();
    }

    private enqueue(job: DedupedJob): void {
        const queue = this.getQueue(job.priority);
        queue.push(job);
    }

    private removeFromQueue(job: DedupedJob): void {
        const queue = this.getQueue(job.priority);
        const index = queue.indexOf(job);
        if (index >= 0) {
            queue.splice(index, 1);
        }
    }

    private updatePendingWeights(): void {
        const pending: ContentWorkBudgets = {
            activeJobs: 0,
            sourceBytes: 0,
            decodedPixels: 0,
            pdfSlots: 0,
            externalSlots: 0
        };

        for (const job of this.jobsByKey.values()) {
            if (!job.started && !job.settled) {
                for (const key of BUDGET_KEYS) {
                    pending[key] += job.weights[key];
                }
            }
        }

        this.pendingWeights = pending;
    }

    private scheduleDrain(): void {
        if (this.drainCycleScheduled || this.isShutdown) {
            return;
        }
        this.drainCycleScheduled = true;
        void Promise.resolve().then(() => this.drain());
    }

    private drain(): void {
        this.drainCycleScheduled = false;
        if (this.isShutdown) {
            return;
        }

        let admitted = true;
        while (admitted) {
            admitted = this.tryAdmitOne();
        }
    }

    private tryAdmitOne(): boolean {
        if (this.isShutdown) {
            return false;
        }

        const job = this.selectNextJob();
        if (!job) {
            return false;
        }

        if (!this.fitsBudget(job.weights)) {
            return false;
        }

        this.startJob(job);
        return true;
    }

    private selectNextJob(): DedupedJob | undefined {
        // Fairness: if higher-priority work has dominated recent admissions and
        // lower-priority work is waiting, force one lower-priority admission.
        if (this.backgroundStarvationCounter >= this.backgroundStarvationThreshold && !this.hasBudgetReservation()) {
            const fairJob = this.findOldestQueuedLowerPriorityJob();
            if (fairJob && this.fitsBudget(fairJob.weights)) {
                this.backgroundStarvationCounter = 0;
                return fairJob;
            }
        }

        for (const priority of CONTENT_WORK_PRIORITY_ORDER) {
            const queue = this.getQueue(priority);
            for (const job of queue) {
                if (job.started || job.settled) {
                    continue;
                }
                if (this.fitsBudget(job.weights)) {
                    job.budgetSkipCount = 0;
                    if (priority === 'background' || priority === 'maintenance') {
                        this.backgroundStarvationCounter = 0;
                    } else if (this.hasQueuedLowerPriorityWork(priority)) {
                        this.backgroundStarvationCounter += 1;
                    }
                    return job;
                }
                job.budgetSkipCount += 1;
                if (job.budgetSkipCount >= this.budgetStarvationThreshold) {
                    return undefined;
                }
            }
        }

        return undefined;
    }

    private findOldestQueuedLowerPriorityJob(): DedupedJob | undefined {
        let oldest: DedupedJob | undefined;
        for (const priority of CONTENT_WORK_PRIORITY_ORDER.slice(1)) {
            const queue = this.getQueue(priority);
            for (const job of queue) {
                if (!job.started && !job.settled && (!oldest || job.sequence < oldest.sequence)) {
                    oldest = job;
                }
            }
        }
        return oldest;
    }

    private hasBudgetReservation(): boolean {
        for (const priority of CONTENT_WORK_PRIORITY_ORDER) {
            if (
                this.getQueue(priority).some(job => !job.started && !job.settled && job.budgetSkipCount >= this.budgetStarvationThreshold)
            ) {
                return true;
            }
        }
        return false;
    }

    private hasQueuedLowerPriorityWork(thanPriority: ContentWorkPriority): boolean {
        const threshold = CONTENT_WORK_PRIORITY_ORDER.indexOf(thanPriority);
        for (let i = threshold + 1; i < CONTENT_WORK_PRIORITY_ORDER.length; i++) {
            const queue = this.getQueue(CONTENT_WORK_PRIORITY_ORDER[i]);
            if (queue.some(job => !job.started && !job.settled)) {
                return true;
            }
        }
        return false;
    }

    private fitsBudget(weights: Required<ContentWorkWeights>): boolean {
        for (const key of BUDGET_KEYS) {
            if (this.activeWeights[key] + weights[key] > this.budgets[key]) {
                return false;
            }
        }
        return true;
    }

    private getQueue(priority: ContentWorkPriority): DedupedJob[] {
        const queue = this.queues.get(priority);
        if (!queue) {
            throw new Error(`Unknown content work priority: ${priority}`);
        }
        return queue;
    }

    private startJob(job: DedupedJob): void {
        this.removeFromQueue(job);
        job.started = true;
        job.running = true;
        this.running.add(job);

        for (const key of BUDGET_KEYS) {
            this.activeWeights[key] += job.weights[key];
        }
        this.updatePendingWeights();

        const settle = (value: unknown, isError: boolean): void => this.settleRunningJob(job, value, isError);

        try {
            const result = job.execute(job.controller.signal);
            const promise = Promise.resolve(result);
            job.resultPromise = promise;
            promise.then(
                value => settle(value, false),
                error => settle(error, true)
            );
        } catch (error) {
            settle(error, true);
        }
    }

    private settleRunningJob(job: DedupedJob, value: unknown, isError: boolean): void {
        if (job.settled) {
            return;
        }
        job.settled = true;
        job.running = false;
        this.running.delete(job);
        if (this.jobsByKey.get(job.key) === job) {
            this.jobsByKey.delete(job.key);
        }

        for (const key of BUDGET_KEYS) {
            this.activeWeights[key] = Math.max(0, this.activeWeights[key] - job.weights[key]);
        }
        this.updatePendingWeights();
        this.settleJob(job, value, isError);

        if (this.isShutdown && this.running.size === 0 && this.shutdownResolver) {
            this.shutdownResolver();
            this.shutdownResolver = null;
        } else if (!this.isShutdown) {
            this.scheduleDrain();
        }
    }

    private settleJob(job: DedupedJob, value: unknown, isError: boolean): void {
        for (const subscriber of job.subscribers) {
            if (subscriber.signal && subscriber.abortHandler) {
                subscriber.signal.removeEventListener('abort', subscriber.abortHandler);
            }
            if (subscriber.cancelled) {
                continue;
            }
            if (subscriber.signal?.aborted) {
                subscriber.reject(makeAbortError());
            } else if (isError) {
                subscriber.reject(value);
            } else {
                subscriber.resolve(value);
            }
        }
        job.subscribers.length = 0;
    }

    private rejectAllQueued(): void {
        for (const job of this.jobsByKey.values()) {
            if (!job.started && !job.settled) {
                this.removeFromQueue(job);
                this.jobsByKey.delete(job.key);
                job.settled = true;
                this.settleJob(job, makeAbortError(), true);
            }
        }
        this.updatePendingWeights();
    }
}
