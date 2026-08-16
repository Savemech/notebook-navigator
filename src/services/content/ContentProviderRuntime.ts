/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Platform, type App } from 'obsidian';
import { LIMITS } from '../../constants/limits';
import { recordGauge, recordHighWater } from '../diagnostics/PerformanceTelemetry';
import { ContentProviderRegistry } from './ContentProviderRegistry';
import { ContentReadCache } from './ContentReadCache';
import { createFeatureImageThumbnailRuntime, FeatureImageContentProvider } from './FeatureImageContentProvider';
import { MarkdownPipelineContentProvider } from './MarkdownPipelineContentProvider';
import { MetadataContentProvider } from './MetadataContentProvider';
import { TagContentProvider } from './TagContentProvider';
import { ContentWorkScheduler, type ContentWorkSnapshot } from './ContentWorkScheduler';

export interface ContentProviderRuntimeSession {
    registry: ContentProviderRegistry;
    release: () => void;
}

export class ContentProviderRuntime {
    private readonly registry: ContentProviderRegistry;
    private readonly scheduler: ContentWorkScheduler;
    private consumerCount = 0;
    private disposed = false;
    private disposePromise: Promise<void> | null = null;

    constructor(app: App) {
        const readCache = new ContentReadCache(app);
        const thumbnailRuntime = createFeatureImageThumbnailRuntime();
        const platformKey = Platform.isMobile ? 'mobile' : 'desktop';
        this.scheduler = new ContentWorkScheduler(
            {
                activeJobs: LIMITS.contentProvider.scheduler.activeJobs,
                sourceBytes: LIMITS.contentProvider.scheduler.maxSourceBytes[platformKey],
                decodedPixels: LIMITS.thumbnails.featureImage.imageDecodeBudgetPixels[platformKey],
                pdfSlots: LIMITS.contentProvider.scheduler.pdfSlots[platformKey],
                externalSlots: LIMITS.contentProvider.scheduler.externalSlots[platformKey]
            },
            { backgroundStarvationThreshold: LIMITS.contentProvider.scheduler.backgroundStarvationThreshold }
        );
        this.registry = new ContentProviderRegistry();
        const providers = [
            new MarkdownPipelineContentProvider(app, readCache, thumbnailRuntime),
            new FeatureImageContentProvider(app, readCache, thumbnailRuntime),
            new MetadataContentProvider(app),
            new TagContentProvider(app)
        ];
        for (const provider of providers) {
            provider.setWorkScheduler(this.scheduler);
            this.registry.registerProvider(provider);
        }
        recordGauge('runtime:contentProvider:instances', 1);
        recordHighWater('runtime:contentProvider:maxInstances', 1);
    }

    acquire(): ContentProviderRuntimeSession {
        if (this.disposed) {
            throw new Error('ContentProviderRuntime is disposed');
        }

        this.consumerCount += 1;
        recordGauge('runtime:contentProvider:consumers', this.consumerCount);
        recordHighWater('runtime:contentProvider:maxConsumers', this.consumerCount);
        let released = false;

        return {
            registry: this.registry,
            release: () => {
                if (released || this.disposed) {
                    return;
                }
                released = true;
                this.consumerCount = Math.max(0, this.consumerCount - 1);
                recordGauge('runtime:contentProvider:consumers', this.consumerCount);
                if (this.consumerCount === 0) {
                    this.registry.stopAllProcessing();
                }
            }
        };
    }

    getConsumerCount(): number {
        return this.consumerCount;
    }

    getSchedulerSnapshot(): ContentWorkSnapshot {
        return this.scheduler.snapshot();
    }

    dispose(): Promise<void> {
        if (this.disposed) {
            return this.disposePromise ?? Promise.resolve();
        }
        this.disposed = true;
        this.consumerCount = 0;
        this.registry.stopAllProcessing();
        this.disposePromise = this.scheduler.shutdown();
        recordGauge('runtime:contentProvider:consumers', 0);
        recordGauge('runtime:contentProvider:instances', 0);
        return this.disposePromise;
    }
}
