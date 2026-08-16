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

import { describe, expect, it } from 'vitest';
import { FeatureImageBlobStore, type FeatureImageBlobStoreOptions } from '../../src/storage/FeatureImageBlobStore';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
    let resolveFn: ((value: T) => void) | null = null;
    let rejectFn: ((reason: unknown) => void) | null = null;
    const promise = new Promise<T>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    if (!resolveFn || !rejectFn) {
        throw new Error('Deferred initialization failed');
    }
    return { promise, resolve: resolveFn, reject: rejectFn };
}

class TestFeatureImageBlobStore extends FeatureImageBlobStore {
    public readonly reads: Array<{ path: string; expectedKey: string }> = [];
    private deferredReads: Deferred<Blob | null>[] = [];

    constructor(
        maxEntries: number,
        maxBytes?: number,
        options?: FeatureImageBlobStoreOptions,
        private readonly deferAbort = false
    ) {
        super(maxEntries, maxBytes, options);
    }

    protected override readBlobFromStore(_db: IDBDatabase, path: string, expectedKey: string, signal?: AbortSignal): Promise<Blob | null> {
        this.reads.push({ path, expectedKey });
        const deferred = createDeferred<Blob | null>();
        this.deferredReads.push(deferred);
        signal?.addEventListener(
            'abort',
            () => {
                if (this.deferAbort) {
                    return;
                }
                const error = new Error('The operation was aborted');
                error.name = 'AbortError';
                deferred.reject(error);
            },
            { once: true }
        );
        return deferred.promise;
    }

    resolveRead(index: number, blob: Blob | null): void {
        const deferred = this.deferredReads[index];
        deferred.resolve(blob);
    }

    rejectRead(index: number, error: Error): void {
        this.deferredReads[index].reject(error);
    }
}

async function waitForReadCount(store: TestFeatureImageBlobStore, expected: number): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (store.reads.length >= expected) {
            return;
        }
        await Promise.resolve();
    }
    throw new Error(`Expected ${expected} reads, received ${store.reads.length}`);
}

describe('FeatureImageBlobStore', () => {
    it('deduplicates concurrent reads and caches results', async () => {
        const store = new TestFeatureImageBlobStore(10);
        const db = {} as IDBDatabase;
        const blob = new Blob(['x']);

        const first = store.getBlob(db, 'file.md', 'k1');
        const second = store.getBlob(db, 'file.md', 'k1');
        await Promise.resolve();

        expect(store.reads).toHaveLength(1);

        store.resolveRead(0, blob);

        expect(await first).toBe(blob);
        expect(await second).toBe(blob);

        expect(await store.getBlob(db, 'file.md', 'k1')).toBe(blob);
        expect(store.reads).toHaveLength(1);
        expect(store.getMemoryCacheStats()).toEqual({ entries: 1, bytes: 1 });
    });

    it('avoids caching stale in-flight reads after invalidation', async () => {
        const store = new TestFeatureImageBlobStore(10);
        const db = {} as IDBDatabase;
        const blobOld = new Blob(['old']);
        const blobNew = new Blob(['new']);

        const first = store.getBlob(db, 'file.md', 'k1');
        await Promise.resolve();
        store.deleteFromCache('file.md');
        const second = store.getBlob(db, 'file.md', 'k1');
        await Promise.resolve();

        expect(store.reads).toHaveLength(2);

        store.resolveRead(1, blobNew);
        store.resolveRead(0, blobOld);

        expect(await second).toBe(blobNew);
        expect(await first).toBe(blobOld);
        expect(await store.getBlob(db, 'file.md', 'k1')).toBe(blobNew);
    });

    it('moves cached entries between paths', async () => {
        const store = new TestFeatureImageBlobStore(10);
        const db = {} as IDBDatabase;
        const blob = new Blob(['x']);

        const first = store.getBlob(db, 'old.md', 'k1');
        await Promise.resolve();
        store.resolveRead(0, blob);
        expect(await first).toBe(blob);

        store.moveCacheEntry('old.md', 'new.md');

        expect(await store.getBlob(db, 'new.md', 'k1')).toBe(blob);
        expect(store.reads).toHaveLength(1);
    });

    it('cancels a queued read before it opens an IndexedDB transaction', async () => {
        const store = new TestFeatureImageBlobStore(10, undefined, { maxConcurrentReads: 1 });
        const db = {} as IDBDatabase;
        const blocker = store.getBlob(db, 'blocker.md', 'kb');
        const controller = new AbortController();
        const queued = store.getBlob(db, 'queued.md', 'kq', { signal: controller.signal, priority: 'background' });
        const queuedExpectation = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
        await Promise.resolve();

        controller.abort();
        store.resolveRead(0, null);
        if (store.reads.length > 1) {
            store.resolveRead(1, null);
        }

        await queuedExpectation;
        await blocker;
        expect(store.reads.map(read => read.path)).toEqual(['blocker.md']);
    });

    it('starts a visible read before an older queued background read', async () => {
        const store = new TestFeatureImageBlobStore(10, undefined, { maxConcurrentReads: 1 });
        const db = {} as IDBDatabase;
        const blocker = store.getBlob(db, 'blocker.md', 'kb');
        await Promise.resolve();
        const background = store.getBlob(db, 'background.md', 'kbg', { priority: 'background' });
        const visible = store.getBlob(db, 'visible.md', 'kv', { priority: 'visible' });

        store.resolveRead(0, null);
        await blocker;
        await waitForReadCount(store, 2);
        expect(store.reads[1].path).toBe('visible.md');
        store.resolveRead(1, null);
        await waitForReadCount(store, 3);
        store.resolveRead(2, null);

        await Promise.all([background, visible]);
        expect(store.reads.map(read => read.path)).toEqual(['blocker.md', 'visible.md', 'background.md']);
    });

    it('releases the read slot after rejection', async () => {
        const store = new TestFeatureImageBlobStore(10, undefined, { maxConcurrentReads: 1 });
        const db = {} as IDBDatabase;
        const failed = store.getBlob(db, 'failed.md', 'kf');
        const next = store.getBlob(db, 'next.md', 'kn');
        const failedExpectation = expect(failed).rejects.toThrow('read failed');
        await waitForReadCount(store, 1);

        store.rejectRead(0, new Error('read failed'));
        await failedExpectation;
        await waitForReadCount(store, 2);
        store.resolveRead(1, null);

        await expect(next).resolves.toBeNull();
    });

    it('keeps a deduped read alive when only one caller aborts', async () => {
        const store = new TestFeatureImageBlobStore(10, undefined, { maxConcurrentReads: 1 });
        const db = {} as IDBDatabase;
        const firstController = new AbortController();
        const secondController = new AbortController();
        const first = store.getBlob(db, 'shared.md', 'ks', { signal: firstController.signal, priority: 'background' });
        const second = store.getBlob(db, 'shared.md', 'ks', { signal: secondController.signal, priority: 'visible' });
        const firstExpectation = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await waitForReadCount(store, 1);

        firstController.abort();
        const blob = new Blob(['shared']);
        store.resolveRead(0, blob);

        await firstExpectation;
        await expect(second).resolves.toBe(blob);
        expect(store.reads).toHaveLength(1);
    });

    it('aborts old reads on cache clear and accepts reads on the replacement scheduler', async () => {
        const store = new TestFeatureImageBlobStore(10, undefined, { maxConcurrentReads: 1 });
        const db = {} as IDBDatabase;
        const oldRead = store.getBlob(db, 'old.md', 'ko');
        const oldExpectation = expect(oldRead).rejects.toMatchObject({ name: 'AbortError' });
        await waitForReadCount(store, 1);

        store.clearMemoryCaches();
        await oldExpectation;

        const newRead = store.getBlob(db, 'new.md', 'kn');
        await waitForReadCount(store, 2);
        const blob = new Blob(['new']);
        store.resolveRead(1, blob);
        await expect(newRead).resolves.toBe(blob);
    });

    it('does not admit replacement reads until the old scheduler has drained', async () => {
        const store = new TestFeatureImageBlobStore(10, undefined, { maxConcurrentReads: 1 }, true);
        const db = {} as IDBDatabase;
        const oldRead = store.getBlob(db, 'old.md', 'ko');
        await waitForReadCount(store, 1);

        store.clearMemoryCaches();
        const newRead = store.getBlob(db, 'new.md', 'kn');
        await Promise.resolve();
        await Promise.resolve();
        expect(store.reads).toHaveLength(1);

        store.resolveRead(0, null);
        await expect(oldRead).resolves.toBeNull();
        await waitForReadCount(store, 2);
        store.resolveRead(1, null);
        await expect(newRead).resolves.toBeNull();
    });
});
