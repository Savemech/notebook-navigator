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

import { App, Platform, TFile } from 'obsidian';
import { IContentProvider, type ContentProviderType, type ContentWorkPriority } from '../../interfaces/IContentProvider';
import type { NotebookNavigatorSettings } from '../../settings/types';
import { FileData } from '../../storage/IndexedDBStorage';
import { getDBInstance, isShutdownInProgress } from '../../storage/fileOperations';
import { getProviderProcessedMtimeField } from '../../storage/providerMtime';
import { runAsyncAction } from '../../utils/async';
import { recordContentProviderBatch } from '../diagnostics/DebugLoggingService';
import { isBenchmarkModeEnabled, recordGauge, recordHighWater } from '../diagnostics/PerformanceTelemetry';
import { ContentReadCache } from './ContentReadCache';
import { waitForBackgroundWorkTurn } from './BackgroundWorkController';
import { LIMITS } from '../../constants/limits';
import { CONTENT_WORK_PRIORITY_ORDER, ContentWorkScheduler } from './ContentWorkScheduler';

interface ContentJob {
    file: TFile;
    path: string;
    priority: ContentWorkPriority;
    signal?: AbortSignal;
}

export type ContentProviderUpdate = {
    path: string;
    tags?: string[] | null;
    wordCount?: number | null;
    characterCountWithSpaces?: number | null;
    characterCountWithoutSpaces?: number | null;
    taskTotal?: number | null;
    taskUnfinished?: number | null;
    preview?: string;
    featureImage?: Blob | null;
    featureImageKey?: string | null;
    metadata?: FileData['metadata'];
    properties?: FileData['properties'];
};

export type ContentProviderProcessResult = {
    update: ContentProviderUpdate | null;
    processed: boolean;
};

/**
 * Base class for content providers
 * Provides common functionality for queue management and batch processing
 */
export abstract class BaseContentProvider implements IContentProvider {
    protected readonly QUEUE_BATCH_SIZE: number = LIMITS.contentProvider.queueBatchSize;
    protected readonly PARALLEL_LIMIT: number = LIMITS.contentProvider.parallelLimit;

    private static readonly RETRY_UNSCHEDULED_AT = Number.MAX_SAFE_INTEGER;
    private static readonly RETRY_INITIAL_DELAY_MS = LIMITS.contentProvider.retry.initialDelayMs;
    private static readonly RETRY_MAX_DELAY_MS = LIMITS.contentProvider.retry.maxDelayMs;
    private static readonly RETRY_MAX_ATTEMPTS = LIMITS.contentProvider.retry.maxAttempts;
    private static readonly WAIT_FOR_IDLE_RETRY_POLL_MS = 25;

    // One FIFO per scheduler priority allows O(1) promotion without scanning a vault-sized queue.
    private priorityQueues = new Map<ContentWorkPriority, string[]>(CONTENT_WORK_PRIORITY_ORDER.map(priority => [priority, []]));
    private priorityQueueHeads = new Map<ContentWorkPriority, number>(CONTENT_WORK_PRIORITY_ORDER.map(priority => [priority, 0]));
    protected isProcessing = false;
    protected abortController: AbortController | null = null;
    protected currentBatchSettings: NotebookNavigatorSettings | null = null;
    // Track files currently being processed to prevent duplicate processing
    // when multiple events fire for the same file in quick succession
    protected processingFiles: Set<string> = new Set();
    // Canonical queued state. Promoted background entries remain stale in the background array and are skipped on dequeue.
    private queuedPriorities = new Map<string, ContentWorkPriority>();
    // Tracks file paths queued while already processing, re-enqueued after the current batch finishes.
    private dirtyFilesDuringProcessing = new Map<string, ContentWorkPriority>();
    private workScheduler: ContentWorkScheduler | null = null;

    // Track provider stop state to prevent any post-stop scheduling or enqueues
    protected stopped = false;

    // Monotonic session counter used to prevent stale batches from writing or mutating provider state after stop/start.
    private processingSession = 0;
    private activeBatchPromise: Promise<void> | null = null;

    private recordQueueMetrics(): void {
        if (!isBenchmarkModeEnabled()) {
            return;
        }
        const type = this.getContentType();
        const depth = this.queuedPriorities.size;
        recordGauge(`provider:${type}:queued`, depth);
        recordHighWater(`provider:${type}:maxQueued`, depth);
    }

    protected getQueuedPathCount(): number {
        return this.queuedPriorities.size;
    }

    private getNextQueuedPriority(): ContentWorkPriority | undefined {
        for (const priority of CONTENT_WORK_PRIORITY_ORDER) {
            const queue = this.priorityQueues.get(priority);
            let head = this.priorityQueueHeads.get(priority) ?? 0;
            if (!queue) {
                continue;
            }
            while (head < queue.length) {
                const path = queue[head];
                if (this.queuedPriorities.get(path) === priority) {
                    this.priorityQueueHeads.set(priority, head);
                    return priority;
                }
                head += 1;
            }
            this.priorityQueueHeads.set(priority, head);
        }
        return undefined;
    }

    private takeQueuedBatch(onlyPriority?: ContentWorkPriority): { path: string; priority: ContentWorkPriority }[] {
        const batch: { path: string; priority: ContentWorkPriority }[] = [];
        const priorities = onlyPriority ? [onlyPriority] : CONTENT_WORK_PRIORITY_ORDER;

        while (batch.length < this.QUEUE_BATCH_SIZE) {
            let path: string | undefined;
            for (const priority of priorities) {
                const queue = this.priorityQueues.get(priority);
                let head = this.priorityQueueHeads.get(priority) ?? 0;
                if (!queue) {
                    continue;
                }
                while (head < queue.length) {
                    const candidate = queue[head++];
                    if (this.queuedPriorities.get(candidate) === priority) {
                        path = candidate;
                        break;
                    }
                }
                this.priorityQueueHeads.set(priority, head);
                if (path !== undefined) {
                    break;
                }
            }
            if (path === undefined) {
                break;
            }
            const priority = this.queuedPriorities.get(path);
            this.queuedPriorities.delete(path);
            if (priority) {
                batch.push({ path, priority });
            }
        }

        for (const priority of CONTENT_WORK_PRIORITY_ORDER) {
            const queue = this.priorityQueues.get(priority);
            const head = this.priorityQueueHeads.get(priority) ?? 0;
            if (queue && head > 1024 && head * 2 > queue.length) {
                this.priorityQueues.set(priority, queue.slice(head));
                this.priorityQueueHeads.set(priority, 0);
            }
        }

        return batch;
    }

    private recordActiveMetrics(): void {
        if (!isBenchmarkModeEnabled()) {
            return;
        }
        const type = this.getContentType();
        const active = this.processingFiles.size;
        recordGauge(`provider:${type}:active`, active);
        recordHighWater(`provider:${type}:maxActive`, active);
    }

    private drainTelemetryGauges(): void {
        if (!isBenchmarkModeEnabled()) {
            return;
        }
        const type = this.getContentType();
        recordGauge(`provider:${type}:queued`, 0);
        recordGauge(`provider:${type}:active`, 0);
    }

    private retryTimer: ReturnType<typeof window.setTimeout> | null = null;
    private retryTimerWindow: Window | null = null;
    private retryState = new Map<string, { attempts: number; nextRetryAt: number }>();

    constructor(
        protected app: App,
        protected readCache: ContentReadCache | null = null
    ) {}

    setWorkScheduler(scheduler: ContentWorkScheduler): void {
        this.workScheduler = scheduler;
    }

    /**
     * Yields to the task queue to keep long provider runs responsive without frame-rate throttling.
     */
    protected async yieldToEventLoop(signal?: AbortSignal): Promise<void> {
        await waitForBackgroundWorkTurn(signal);
    }

    protected readFileContent(file: TFile): Promise<string> {
        if (this.readCache) {
            return this.readCache.readFile(file);
        }
        return this.app.vault.cachedRead(file);
    }

    private runProcessNextBatch(): void {
        runAsyncAction(() => {
            const promise = this.processNextBatch();
            this.activeBatchPromise = promise;
            return promise.finally(() => {
                if (this.activeBatchPromise === promise) {
                    this.activeBatchPromise = null;
                }
            });
        });
    }

    private clearRetryTimer(): void {
        if (this.retryTimer !== null) {
            (this.retryTimerWindow ?? activeWindow).clearTimeout(this.retryTimer);
            this.retryTimer = null;
            this.retryTimerWindow = null;
        }
    }

    private clearRetryState(): void {
        this.clearRetryTimer();
        this.retryState.clear();
    }

    // Returns true when at least one retry entry has a scheduled retry timestamp.
    private hasScheduledRetryWork(): boolean {
        for (const state of this.retryState.values()) {
            if (state.nextRetryAt !== BaseContentProvider.RETRY_UNSCHEDULED_AT) {
                return true;
            }
        }
        return false;
    }

    private clearRetryForPath(path: string): void {
        if (!this.retryState.delete(path)) {
            return;
        }
        this.scheduleRetryTimer(this.processingSession);
    }

    private scheduleRetry(path: string, session: number): void {
        if (this.stopped || this.processingSession !== session) {
            return;
        }

        const existing = this.retryState.get(path);
        const attempts = existing ? existing.attempts + 1 : 1;
        if (attempts > BaseContentProvider.RETRY_MAX_ATTEMPTS) {
            if (existing) {
                console.error('Content provider dropped file after retry exhaustion', {
                    provider: this.getContentType(),
                    path,
                    attempts
                });
                this.retryState.delete(path);
                this.scheduleRetryTimer(session);
            }
            return;
        }

        const delay = Math.min(BaseContentProvider.RETRY_INITIAL_DELAY_MS * 2 ** (attempts - 1), BaseContentProvider.RETRY_MAX_DELAY_MS);

        this.retryState.set(path, { attempts, nextRetryAt: Date.now() + delay });
        this.scheduleRetryTimer(session);
    }

    private scheduleRetryTimer(session: number): void {
        if (this.stopped || this.processingSession !== session || this.retryState.size === 0) {
            this.clearRetryTimer();
            return;
        }

        let nextRetryAt = BaseContentProvider.RETRY_UNSCHEDULED_AT;
        for (const state of this.retryState.values()) {
            if (state.nextRetryAt === BaseContentProvider.RETRY_UNSCHEDULED_AT) {
                continue;
            }
            if (state.nextRetryAt < nextRetryAt) {
                nextRetryAt = state.nextRetryAt;
            }
        }

        if (nextRetryAt === BaseContentProvider.RETRY_UNSCHEDULED_AT) {
            this.clearRetryTimer();
            return;
        }

        this.clearRetryTimer();
        const delay = Math.max(0, nextRetryAt - Date.now());
        const timerWindow = activeWindow;
        this.retryTimerWindow = timerWindow;
        this.retryTimer = timerWindow.setTimeout(() => {
            this.retryTimer = null;
            this.retryTimerWindow = null;
            this.flushRetries(session);
        }, delay);
    }

    private flushRetries(session: number): void {
        if (this.stopped || this.processingSession !== session || this.retryState.size === 0) {
            this.clearRetryState();
            return;
        }

        const now = Date.now();
        const filesToRetry: TFile[] = [];

        for (const [path, state] of this.retryState) {
            if (state.nextRetryAt > now) {
                continue;
            }

            const abstract = this.app.vault.getAbstractFileByPath(path);
            if (abstract instanceof TFile) {
                filesToRetry.push(abstract);
                this.retryState.set(path, { ...state, nextRetryAt: BaseContentProvider.RETRY_UNSCHEDULED_AT });
            } else {
                this.retryState.delete(path);
            }
        }

        if (filesToRetry.length > 0) {
            this.queueFiles(filesToRetry);
        }

        this.scheduleRetryTimer(session);
    }

    abstract getContentType(): ContentProviderType;
    abstract getRelevantSettings(): (keyof NotebookNavigatorSettings)[];
    abstract shouldRegenerate(oldSettings: NotebookNavigatorSettings, newSettings: NotebookNavigatorSettings): boolean;
    abstract clearContent(context?: { oldSettings: NotebookNavigatorSettings; newSettings: NotebookNavigatorSettings }): Promise<void>;

    /**
     * Process a single file to generate content
     * @param job - The job to process
     * @param fileData - Existing file data from database
     * @param settings - Current settings
     * @returns Updated file data or null if no update needed
     */
    protected abstract processFile(
        job: ContentJob,
        fileData: FileData | null,
        settings: NotebookNavigatorSettings
    ): Promise<ContentProviderProcessResult>;

    /**
     * Checks if a file needs processing
     * @param fileData - Existing file data
     * @param file - The file to check
     * @param settings - Current settings
     * @returns True if the file needs processing
     */
    protected abstract needsProcessing(fileData: FileData | null, file: TFile, settings: NotebookNavigatorSettings): boolean;

    /**
     * Runs after a provider session drains all queued work.
     */
    protected onProcessingIdle(): void {}

    queueFiles(files: TFile[], options?: { priority?: ContentWorkPriority }): void {
        if (this.stopped) return;
        const priority = options?.priority ?? 'background';
        // Filter out files that are currently being processed or already queued
        let queuedWork = false;
        for (const file of files) {
            const p = file.path;
            if (this.processingFiles.has(p)) {
                const dirtyPriority = this.dirtyFilesDuringProcessing.get(p);
                if (!dirtyPriority || CONTENT_WORK_PRIORITY_ORDER.indexOf(priority) < CONTENT_WORK_PRIORITY_ORDER.indexOf(dirtyPriority)) {
                    this.dirtyFilesDuringProcessing.set(p, priority);
                }
                continue;
            }
            const queuedPriority = this.queuedPriorities.get(p);
            if (queuedPriority && CONTENT_WORK_PRIORITY_ORDER.indexOf(queuedPriority) <= CONTENT_WORK_PRIORITY_ORDER.indexOf(priority)) {
                continue;
            }
            this.queuedPriorities.set(p, priority);
            this.priorityQueues.get(priority)?.push(p);
            queuedWork = true;
        }

        this.recordQueueMetrics();

        if (queuedWork && !this.isProcessing && this.currentBatchSettings) {
            // Run queued work immediately.
            // `ContentProviderRegistry` calls `startProcessing()` first, but direct callers can enqueue while idle.
            this.runProcessNextBatch();
        }
    }

    startProcessing(settings: NotebookNavigatorSettings): void {
        // Allow restarting after a stop
        this.stopped = false;
        this.currentBatchSettings = settings;

        if (!this.stopped && !this.isProcessing && this.queuedPriorities.size > 0) {
            this.runProcessNextBatch();
        }
    }

    onSettingsChanged(settings: NotebookNavigatorSettings): void {
        this.currentBatchSettings = settings;
    }

    // Treats queued files, in-flight batches, and scheduled retries as pending provider work.
    private hasPendingWork(): boolean {
        return (
            this.isProcessing ||
            this.activeBatchPromise !== null ||
            this.queuedPriorities.size > 0 ||
            this.retryTimer !== null ||
            this.hasScheduledRetryWork()
        );
    }

    async waitForIdle(): Promise<void> {
        while (this.hasPendingWork()) {
            const promise = this.activeBatchPromise;
            if (promise) {
                try {
                    await promise;
                } catch {
                    // Errors are already logged by runAsyncAction().
                }
            } else if (this.retryTimer !== null || this.hasScheduledRetryWork()) {
                // Retry work advances on timers; poll until retries are flushed or cleared.
                await new Promise<void>(resolve => window.setTimeout(resolve, BaseContentProvider.WAIT_FOR_IDLE_RETRY_POLL_MS));
            } else {
                await this.yieldToEventLoop();
            }
        }
    }

    protected async processNextBatch(): Promise<void> {
        if (this.stopped || this.isProcessing || this.queuedPriorities.size === 0 || !this.currentBatchSettings) {
            return;
        }

        this.isProcessing = true;
        const session = this.processingSession;
        this.abortController = new AbortController();
        const abortSignal = this.abortController.signal;
        const settings = this.currentBatchSettings;
        // Reuses provider type across all mtime lookups and writes in this batch session.
        const type = this.getContentType();

        // Declare activeJobs outside try block so it's accessible in finally
        let activeJobs: { job: ContentJob; fileData: FileData | null; needsProcessing: boolean; expectedProviderMtime: number }[] = [];

        try {
            const nextPriority = this.getNextQueuedPriority();
            if (nextPriority !== 'visible') {
                await this.yieldToEventLoop(abortSignal);
            }
            if (this.stopped || abortSignal.aborted || this.processingSession !== session) {
                return;
            }

            const db = getDBInstance();
            const batch = this.takeQueuedBatch(nextPriority === 'visible' ? 'visible' : undefined);
            this.recordQueueMetrics();

            // Filter jobs based on current settings and database state
            // Uses synchronous database access for immediate results
            const jobsWithData: { job: ContentJob; fileData: FileData | null; needsProcessing: boolean; expectedProviderMtime: number }[] =
                [];
            for (const { path, priority } of batch) {
                // Re-resolve each path to pick up deletes/renames and avoid holding stale `TFile` references.
                const abstract = this.app.vault.getAbstractFileByPath(path);
                if (!(abstract instanceof TFile)) {
                    // The path disappeared while waiting in the queue; stale retry entries for this path are no longer valid.
                    this.clearRetryForPath(path);
                    continue;
                }
                const file = abstract;
                // Use the current canonical path from the vault in case the file moved between enqueue and processing.
                const canonicalPath = file.path;
                const fileData = db.getFile(canonicalPath);
                const needsProcessing = this.needsProcessing(fileData, file, settings);
                if (!needsProcessing) {
                    // The file no longer requires processing; remove any queued retry entry to avoid indefinite idle waits.
                    this.clearRetryForPath(canonicalPath);
                }
                const expectedProviderMtime = fileData ? fileData[getProviderProcessedMtimeField(type)] : 0;
                jobsWithData.push({ job: { file, path: canonicalPath, priority }, fileData, needsProcessing, expectedProviderMtime });
            }

            activeJobs = jobsWithData.filter(item => item.needsProcessing);

            if (activeJobs.length === 0) {
                return;
            }

            // Mark files as being processed
            activeJobs.forEach(({ job }) => {
                this.processingFiles.add(job.path);
            });
            this.recordActiveMetrics();

            // Process files in parallel batches
            const updates: ContentProviderUpdate[] = [];
            const processedMtimeUpdates: { path: string; mtime: number; expectedPreviousMtime: number }[] = [];

            // Intentionally process parallel batches back-to-back.
            // This path prioritizes throughput during bulk settings-triggered regeneration.
            for (let i = 0; i < activeJobs.length; i += this.PARALLEL_LIMIT) {
                if (this.stopped || abortSignal.aborted || this.processingSession !== session) break;

                const parallelBatch = activeJobs.slice(i, i + this.PARALLEL_LIMIT);
                const results = await Promise.all(
                    parallelBatch.map(async ({ job, fileData, expectedProviderMtime }) => {
                        try {
                            const fileMtimeAtStart = job.file.stat.mtime;
                            const sourceByteBudget =
                                LIMITS.contentProvider.scheduler.maxSourceBytes[Platform.isMobile ? 'mobile' : 'desktop'];
                            const sourceBytes = Number.isFinite(job.file.stat.size) ? Math.max(0, job.file.stat.size) : 0;
                            const result = this.workScheduler
                                ? await this.workScheduler.schedule({
                                      key: `${type}:${job.path}:${fileMtimeAtStart}:${expectedProviderMtime}`,
                                      priority: job.priority,
                                      weights: { sourceBytes: Math.min(sourceBytes, sourceByteBudget) },
                                      signal: abortSignal,
                                      execute: signal => this.processFile({ ...job, signal }, fileData, settings)
                                  })
                                : await this.processFile(job, fileData, settings);
                            return { job, result, fileMtimeAtStart, expectedProviderMtime };
                        } catch (error) {
                            console.error(`Error processing ${job.file.path}:`, error);
                            return {
                                job,
                                result: { update: null, processed: false },
                                fileMtimeAtStart: job.file.stat.mtime,
                                expectedProviderMtime
                            };
                        }
                    })
                );

                results.forEach(({ job, result, fileMtimeAtStart, expectedProviderMtime }) => {
                    // A rename handler owns the new path. Never let a completion captured under the old
                    // canonical path overwrite data queued by that handler for the renamed file.
                    if (job.file.path !== job.path) {
                        this.clearRetryForPath(job.path);
                        return;
                    }
                    const currentPath = job.path;
                    if (this.processingSession === session && !this.stopped && !abortSignal.aborted) {
                        if (!result.processed) {
                            this.scheduleRetry(currentPath, session);
                        } else {
                            this.clearRetryForPath(currentPath);
                        }
                    }

                    // Avoids writing provider mtime when the stored value already matches this batch snapshot.
                    if (result.processed && fileMtimeAtStart !== expectedProviderMtime) {
                        processedMtimeUpdates.push({
                            path: currentPath,
                            mtime: fileMtimeAtStart,
                            expectedPreviousMtime: expectedProviderMtime
                        });
                    }

                    if (result.update) {
                        // Normalize update path to the current file path before persisting.
                        updates.push({ ...result.update, path: currentPath });
                    }
                });

                const nextIndex = i + this.PARALLEL_LIMIT;
                const nextParallelBatch = activeJobs.slice(nextIndex, nextIndex + this.PARALLEL_LIMIT);
                const requeueRemainingForVisibleWork = (): boolean => {
                    if (nextParallelBatch.length === 0 || this.getNextQueuedPriority() !== 'visible') {
                        return false;
                    }
                    const remainingJobs = activeJobs.slice(nextIndex);
                    for (const priority of CONTENT_WORK_PRIORITY_ORDER) {
                        const matchingJobs = remainingJobs.filter(item => item.job.priority === priority);
                        for (const item of matchingJobs) {
                            this.processingFiles.delete(item.job.path);
                        }
                        const files = matchingJobs.map(item => item.job.file);
                        if (files.length > 0) {
                            this.queueFiles(files, { priority });
                        }
                    }
                    activeJobs = activeJobs.slice(0, nextIndex);
                    this.recordActiveMetrics();
                    return true;
                };
                if (requeueRemainingForVisibleWork()) {
                    break;
                }
                if (nextParallelBatch.some(item => item.job.priority !== 'visible')) {
                    await this.yieldToEventLoop(abortSignal);
                    if (requeueRemainingForVisibleWork()) {
                        break;
                    }
                }
            }

            // Batch update database
            if (
                !(this.stopped || abortSignal.aborted || this.processingSession !== session) &&
                (updates.length > 0 || processedMtimeUpdates.length > 0)
            ) {
                // During plugin shutdown, skip writes to avoid benign transaction errors
                if (!isShutdownInProgress()) {
                    await db.batchUpdateFileContentAndProviderProcessedMtimes({
                        provider: type,
                        contentUpdates: updates,
                        processedMtimeUpdates
                    });
                }
            }
            recordContentProviderBatch({
                provider: type,
                queued: batch.length,
                active: activeJobs.length,
                contentUpdates: updates.length,
                processedMtimeUpdates: processedMtimeUpdates.length
            });
        } catch (error: unknown) {
            // Check if error is an abort operation (user-initiated cancellation)
            const isAbortError = error instanceof DOMException && error.name === 'AbortError';
            if (!isAbortError) {
                console.error('Error processing batch:', error);
            }
        } finally {
            const isActiveSession = this.processingSession === session && !this.stopped && !abortSignal.aborted;

            if (this.processingSession === session) {
                // Remove processed files from tracking set
                activeJobs.forEach(({ job }) => {
                    this.processingFiles.delete(job.path);
                });
            }

            if (isActiveSession) {
                const visibleDirtyFiles: TFile[] = [];
                const backgroundDirtyFiles: TFile[] = [];
                for (const [path, priority] of this.dirtyFilesDuringProcessing) {
                    const abstract = this.app.vault.getAbstractFileByPath(path);
                    if (abstract instanceof TFile) {
                        (priority === 'visible' ? visibleDirtyFiles : backgroundDirtyFiles).push(abstract);
                    }
                }
                this.dirtyFilesDuringProcessing.clear();
                this.queueFiles(visibleDirtyFiles, { priority: 'visible' });
                this.queueFiles(backgroundDirtyFiles, { priority: 'background' });
            } else if (this.processingSession === session) {
                this.dirtyFilesDuringProcessing.clear();
            }

            this.recordQueueMetrics();
            this.recordActiveMetrics();

            this.isProcessing = false;

            if (isActiveSession && this.queuedPriorities.size === 0) {
                // Signals subclasses once queued and dirty-file work has drained for this session.
                this.onProcessingIdle();
            }

            if (this.queuedPriorities.size > 0 && isActiveSession) {
                this.runProcessNextBatch();
            }
        }
    }

    stopProcessing(): void {
        this.processingSession += 1;
        // Mark stopped first so any in-flight logic can observe it
        this.stopped = true;

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        this.clearRetryState();
        this.isProcessing = false;
        this.priorityQueues = new Map(CONTENT_WORK_PRIORITY_ORDER.map(priority => [priority, []]));
        this.priorityQueueHeads = new Map(CONTENT_WORK_PRIORITY_ORDER.map(priority => [priority, 0]));
        this.processingFiles.clear();
        this.queuedPriorities.clear();
        this.dirtyFilesDuringProcessing.clear();
        this.drainTelemetryGauges();
    }
}
