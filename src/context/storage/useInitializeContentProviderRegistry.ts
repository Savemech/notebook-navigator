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

import { useEffect, type MutableRefObject } from 'react';
import type NotebookNavigatorPlugin from '../../main';
import { ContentProviderRegistry } from '../../services/content/ContentProviderRegistry';

/**
 * Creates and tears down the `ContentProviderRegistry` used by `StorageContext`.
 *
 * The registry owns background queues that generate derived content (preview text, feature images, tags, metadata).
 * It is stored in a ref so that:
 * - Event handlers and async callbacks can always reach the current registry instance.
 * - We can stop processing synchronously during teardown without waiting for a render cycle.
 *
 * Providers are registered once per `App` instance to avoid duplicating background queues when the view remounts.
 */
export function useInitializeContentProviderRegistry(params: {
    contentProviderRuntime: Pick<NotebookNavigatorPlugin, 'acquireContentProviderRuntime'>;
    contentRegistryRef: MutableRefObject<ContentProviderRegistry | null>;
    pendingSyncTimeoutIdRef: MutableRefObject<number | null>;
    clearCacheRebuildNotice: () => void;
}): void {
    const { contentProviderRuntime, contentRegistryRef, pendingSyncTimeoutIdRef, clearCacheRebuildNotice } = params;

    useEffect(() => {
        const session = contentProviderRuntime.acquireContentProviderRuntime();
        contentRegistryRef.current = session.registry;

        return () => {
            // The rebuild notice is UI state owned by `StorageContext`, but its timer lives in this module.
            // Always clear it during teardown so the interval does not keep running after the view is closed.
            clearCacheRebuildNotice();

            if (contentRegistryRef.current === session.registry) {
                contentRegistryRef.current = null;
            }
            session.release();

            // Cancel any pending deferred storage sync as an extra safeguard during teardown.
            if (pendingSyncTimeoutIdRef.current !== null) {
                if (typeof window !== 'undefined') {
                    window.clearTimeout(pendingSyncTimeoutIdRef.current);
                }
                pendingSyncTimeoutIdRef.current = null;
            }
        };
    }, [clearCacheRebuildNotice, contentProviderRuntime, contentRegistryRef, pendingSyncTimeoutIdRef]);
}
