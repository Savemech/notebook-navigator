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

export interface FeatureImageBlobEntry {
    featureImageKey: string;
    blob: Blob;
}

/**
 * FeatureImageBlobCache - LRU cache keyed by file path.
 *
 * Stores a bounded number of feature image blobs in memory.
 *
 * Notes:
 * - This is a pure in-memory cache; it does not read from IndexedDB.
 * - Cached entries are scoped by `featureImageKey` so stale thumbnails are dropped
 *   when the selected feature image reference changes.
 */
export class FeatureImageBlobCache {
    // Map preserves insertion order; the first entry is the least recently used (LRU).
    private entries = new Map<string, FeatureImageBlobEntry>();
    // Maximum number of cached entries retained in memory.
    private maxEntries: number;
    private readonly maxBytes: number;
    private totalBytes = 0;

    constructor(maxEntries: number, maxBytes: number = Number.POSITIVE_INFINITY) {
        // Clamp to non-negative limits to keep the cache bounded.
        this.maxEntries = Math.max(0, maxEntries);
        this.maxBytes = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : Number.POSITIVE_INFINITY;
    }

    get(path: string, expectedKey: string): Blob | null {
        // Return a blob only when both:
        // - `path` exists in the cache, and
        // - the stored key matches the caller's expected key.
        const entry = this.entries.get(path);
        if (!entry) {
            return null;
        }
        if (entry.featureImageKey !== expectedKey) {
            // The key mismatch indicates the stored blob belongs to an older feature image reference.
            // Drop the stale entry so future reads fall back to IndexedDB.
            this.removeEntry(path);
            return null;
        }
        // Refresh LRU order by re-inserting the entry as the most-recently-used.
        this.entries.delete(path);
        this.entries.set(path, entry);
        return entry.blob;
    }

    set(path: string, entry: FeatureImageBlobEntry): void {
        // Skip inserts when the cache is disabled.
        if (this.maxEntries === 0 || this.maxBytes === 0) {
            return;
        }
        // Reject entries that can never fit without flushing unrelated warm cache entries first.
        if (entry.blob.size > this.maxBytes) {
            this.removeEntry(path);
            return;
        }
        // Replace existing entries so the newest insert becomes most-recently-used.
        this.removeEntry(path);
        this.entries.set(path, entry);
        this.totalBytes += entry.blob.size;
        this.evictIfNeeded();
    }

    delete(path: string): void {
        // Remove any cached entry for the path.
        this.removeEntry(path);
    }

    peek(path: string): FeatureImageBlobEntry | null {
        return this.entries.get(path) ?? null;
    }

    move(oldPath: string, newPath: string, featureImageKey?: string): void {
        // Used when a file is renamed/moved so the thumbnail remains available
        // without requiring an IndexedDB read.
        const entry = this.entries.get(oldPath);
        if (!entry) {
            return;
        }
        // Preserve the entry while updating its cache key (path).
        this.removeEntry(oldPath);
        this.removeEntry(newPath);
        this.entries.set(newPath, featureImageKey === undefined ? entry : { ...entry, featureImageKey });
        this.totalBytes += entry.blob.size;
        this.evictIfNeeded();
    }

    clear(): void {
        // Remove all cached entries.
        this.entries.clear();
        this.totalBytes = 0;
    }

    getEntryCount(): number {
        // Expose current entry count for cache stats or tests.
        return this.entries.size;
    }

    getTotalBytes(): number {
        return this.totalBytes;
    }

    private evictIfNeeded(): void {
        // Evict least-recently-used entries until both cache bounds are satisfied.
        while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
            // The first key in insertion order is the least-recently-used.
            const iterator = this.entries.keys();
            const first = iterator.next();
            if (first.done) {
                return;
            }
            this.removeEntry(first.value);
        }
    }

    private removeEntry(path: string): void {
        const entry = this.entries.get(path);
        if (!entry) {
            return;
        }
        this.entries.delete(path);
        this.totalBytes = Math.max(0, this.totalBytes - entry.blob.size);
    }
}
