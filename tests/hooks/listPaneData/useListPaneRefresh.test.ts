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
import { App, TFile } from 'obsidian';
import { ItemType } from '../../../src/types';
import {
    getModifiedSortBoundaryRefreshKey,
    hasPropertySearchContentChange,
    shouldRefreshListTopologyForContentChanges,
    shouldRefreshListTopologyForVaultChange,
    shouldRefreshForCustomGroupHeaderMetadataChange,
    shouldSkipModifiedSortBoundaryRefresh
} from '../../../src/hooks/listPaneData/useListPaneRefresh';

function createFile(path: string, mtime: number): TFile {
    const file = new TFile(path);
    file.stat.mtime = mtime;
    file.stat.ctime = mtime;
    return file;
}

describe('getModifiedSortBoundaryRefreshKey', () => {
    const today = new Date(2026, 5, 23, 12).getTime();
    const yesterday = new Date(2026, 5, 22, 12).getTime();

    it('returns a key for the first file in modified-desc order', () => {
        const first = createFile('notes/first.md', today);
        const second = createFile('notes/second.md', yesterday);

        const key = getModifiedSortBoundaryRefreshKey({
            dayKey: '2026-06-23',
            file: first,
            files: [first, second],
            groupBy: 'date',
            sortOption: 'modified-desc'
        });

        expect(key).toBe('modified-desc\u0000date\u0000relative:today\u00002');
    });

    it('returns a key for the last file in modified-asc order', () => {
        const first = createFile('notes/first.md', yesterday);
        const second = createFile('notes/second.md', today);

        const key = getModifiedSortBoundaryRefreshKey({
            dayKey: '2026-06-23',
            file: second,
            files: [first, second],
            groupBy: 'date',
            sortOption: 'modified-asc'
        });

        expect(key).toBe('modified-asc\u0000date\u0000relative:today\u00002');
    });

    it('returns null for non-boundary files and non-primary modified sorts', () => {
        const first = createFile('notes/first.md', today);
        const second = createFile('notes/second.md', yesterday);

        expect(
            getModifiedSortBoundaryRefreshKey({
                dayKey: '2026-06-23',
                file: second,
                files: [first, second],
                groupBy: 'date',
                sortOption: 'modified-desc'
            })
        ).toBeNull();
        expect(
            getModifiedSortBoundaryRefreshKey({
                dayKey: '2026-06-23',
                file: first,
                files: [first, second],
                groupBy: 'date',
                sortOption: 'property-asc'
            })
        ).toBeNull();
    });

    it('changes keys when date grouping changes', () => {
        const file = createFile('notes/current.md', today);
        const todayKey = getModifiedSortBoundaryRefreshKey({
            dayKey: '2026-06-23',
            file,
            files: [file],
            groupBy: 'date',
            sortOption: 'modified-desc'
        });

        file.stat.mtime = yesterday;
        const yesterdayKey = getModifiedSortBoundaryRefreshKey({
            dayKey: '2026-06-23',
            file,
            files: [file],
            groupBy: 'date',
            sortOption: 'modified-desc'
        });

        expect(todayKey).not.toBe(yesterdayKey);
    });

    it('skips unchanged boundary refreshes only when dates, tooltips, and date filters are inactive', () => {
        const boundaryRefreshKey = 'modified-desc\u0000date\u0000relative:today\u00002';

        expect(
            shouldSkipModifiedSortBoundaryRefresh({
                previousBoundaryRefreshKey: boundaryRefreshKey,
                boundaryRefreshKey,
                hasDateSearchFilters: false,
                showFileDate: false,
                showTooltips: false
            })
        ).toBe(true);

        expect(
            shouldSkipModifiedSortBoundaryRefresh({
                previousBoundaryRefreshKey: boundaryRefreshKey,
                boundaryRefreshKey,
                hasDateSearchFilters: false,
                showFileDate: true,
                showTooltips: false
            })
        ).toBe(false);

        expect(
            shouldSkipModifiedSortBoundaryRefresh({
                previousBoundaryRefreshKey: boundaryRefreshKey,
                boundaryRefreshKey,
                hasDateSearchFilters: false,
                showFileDate: false,
                showTooltips: true
            })
        ).toBe(false);

        expect(
            shouldSkipModifiedSortBoundaryRefresh({
                previousBoundaryRefreshKey: boundaryRefreshKey,
                boundaryRefreshKey,
                hasDateSearchFilters: true,
                showFileDate: false,
                showTooltips: false
            })
        ).toBe(false);
    });
});

describe('hasPropertySearchContentChange', () => {
    it('detects property writes inside the unfiltered list scope', () => {
        const basePathSet = new Set(['notes/in-scope.md']);

        expect(
            hasPropertySearchContentChange([{ path: 'notes/in-scope.md', changes: { properties: [] }, changeType: 'content' }], basePathSet)
        ).toBe(true);
        expect(
            hasPropertySearchContentChange(
                [
                    { path: 'notes/outside.md', changes: { properties: [] }, changeType: 'content' },
                    { path: 'notes/in-scope.md', changes: { taskUnfinished: 1 }, changeType: 'content' }
                ],
                basePathSet
            )
        ).toBe(false);
    });
});

describe('shouldRefreshListTopologyForContentChanges', () => {
    const baseArgs = {
        basePathSet: new Set(['notes/current.md']),
        hasManualSortWordCountGroupHeaders: false,
        hasPropertySearchFilters: false,
        hasTaskSearchFilters: false,
        hiddenFilePropertyCriteria: false,
        hiddenFileTags: [] as string[],
        includeDescendantNotes: false,
        selectedFolderPath: 'notes',
        selectedProperty: null,
        selectedTag: null,
        selectionType: ItemType.FOLDER,
        showFileBackgroundUnfinishedTask: false,
        showHiddenItems: false
    };

    it('preserves topology for preview and feature-image row updates', () => {
        expect(
            shouldRefreshListTopologyForContentChanges({
                ...baseArgs,
                changes: [
                    { path: 'notes/current.md', changes: { preview: 'updated' }, changeType: 'content' },
                    { path: 'notes/current.md', changes: { featureImageKey: 'image-key' }, changeType: 'content' }
                ]
            })
        ).toBe(false);
    });

    it('refreshes topology when an active task filter depends on the changed row', () => {
        expect(
            shouldRefreshListTopologyForContentChanges({
                ...baseArgs,
                changes: [{ path: 'notes/current.md', changes: { taskUnfinished: 1 }, changeType: 'content' }],
                hasTaskSearchFilters: true
            })
        ).toBe(true);
    });
});

describe('shouldRefreshListTopologyForVaultChange', () => {
    const folderArgs = {
        basePathSet: new Set(['current/existing.md']),
        includeDescendantNotes: false,
        selectedFolderPath: 'current',
        selectionType: ItemType.FOLDER
    };

    it('ignores file changes outside the selected folder topology', () => {
        expect(shouldRefreshListTopologyForVaultChange({ ...folderArgs, path: 'other/new.md' })).toBe(false);
        expect(
            shouldRefreshListTopologyForVaultChange({
                ...folderArgs,
                oldPath: 'other/old.md',
                path: 'other/renamed.md'
            })
        ).toBe(false);
    });

    it('refreshes for in-scope create, delete, and rename boundaries', () => {
        expect(shouldRefreshListTopologyForVaultChange({ ...folderArgs, path: 'current/new.md' })).toBe(true);
        expect(shouldRefreshListTopologyForVaultChange({ ...folderArgs, path: 'current/existing.md' })).toBe(true);
        expect(
            shouldRefreshListTopologyForVaultChange({
                ...folderArgs,
                oldPath: 'current/existing.md',
                path: 'other/moved.md'
            })
        ).toBe(true);
    });
});

describe('shouldRefreshForCustomGroupHeaderMetadataChange', () => {
    it('detects removal from an owner retained by the search count snapshot', () => {
        const app = new App();
        const file = createFile('notes/previous-header.md', 0);
        app.metadataCache.getFileCache = () => ({ frontmatter: {} });

        expect(
            shouldRefreshForCustomGroupHeaderMetadataChange({
                app,
                basePathSet: new Set([file.path]),
                cachedCustomGroupHeaderFilePaths: new Set([file.path]),
                customGroupHeaderFilePaths: new Set(),
                file,
                manualSortGroupHeaderPropertyKey: 'group_header',
                shouldRefreshOnCustomGroupHeaderMetadataChange: true
            })
        ).toBe(true);
    });

    it('detects a newly added header that is absent from the search count snapshot', () => {
        const app = new App();
        const file = createFile('notes/new-header.md', 0);
        app.metadataCache.getFileCache = () => ({ frontmatter: { group_header: 'New group' } });

        expect(
            shouldRefreshForCustomGroupHeaderMetadataChange({
                app,
                basePathSet: new Set([file.path]),
                cachedCustomGroupHeaderFilePaths: new Set(),
                customGroupHeaderFilePaths: new Set(),
                file,
                manualSortGroupHeaderPropertyKey: 'group_header',
                shouldRefreshOnCustomGroupHeaderMetadataChange: true
            })
        ).toBe(true);
    });

    it('ignores metadata changes outside the unfiltered list scope', () => {
        const app = new App();
        const file = createFile('notes/outside.md', 0);
        app.metadataCache.getFileCache = () => ({ frontmatter: { group_header: 'Outside group' } });

        expect(
            shouldRefreshForCustomGroupHeaderMetadataChange({
                app,
                basePathSet: new Set(),
                cachedCustomGroupHeaderFilePaths: new Set([file.path]),
                customGroupHeaderFilePaths: new Set([file.path]),
                file,
                manualSortGroupHeaderPropertyKey: 'group_header',
                shouldRefreshOnCustomGroupHeaderMetadataChange: true
            })
        ).toBe(false);
    });
});
