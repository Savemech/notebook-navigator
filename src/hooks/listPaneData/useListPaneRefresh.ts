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

import { useEffect, useLayoutEffect, useRef } from 'react';
import { TFile } from 'obsidian';
import { debounce } from 'obsidian';
import type { App, TFolder } from 'obsidian';
import { getPropertyGroupingKey } from '../../settings/types';
import type { ListNoteGroupingOption, NotebookNavigatorSettings, PropertySortSecondaryOption, SortOption } from '../../settings/types';
import { TIMEOUTS } from '../../types/obsidian-extended';
import { OperationType, type CommandQueueService } from '../../services/CommandQueueService';
import { shouldExcludeFileWithMatcher } from '../../utils/fileFilters';
import { shouldRefreshOnFileModifyForSort, shouldRefreshOnMetadataChangeForSort } from '../../utils/sortUtils';
import type { FileContentChange, IndexedDBStorage } from '../../storage/IndexedDBStorage';
import type { IPropertyTreeProvider } from '../../interfaces/IPropertyTreeProvider';
import type { ITagTreeProvider } from '../../interfaces/ITagTreeProvider';
import { ItemType, TAGGED_TAG_ID, UNTAGGED_TAG_ID } from '../../types';
import type { PropertySelectionNodeId } from '../../utils/propertyTree';
import { createFrontmatterPropertyExclusionMatcher } from '../../utils/fileFilters';
import { getCachedManualSortGroupHeader } from '../../utils/manualSort';
import { DateUtils } from '../../utils/dateUtils';

interface UseListPaneRefreshArgs {
    app: App;
    basePathSet: ReadonlySet<string>;
    cachedCustomGroupHeaderFilePaths: ReadonlySet<string>;
    commandQueue: CommandQueueService | null;
    customGroupHeaderFilePaths: ReadonlySet<string>;
    dayKey: string;
    files: readonly TFile[];
    getDB: () => IndexedDBStorage;
    groupBy: ListNoteGroupingOption;
    hasDateSearchFilters: boolean;
    hasManualSortWordCountGroupHeaders: boolean;
    hasPropertySearchFilters: boolean;
    hasTaskSearchFilters: boolean;
    hiddenFilePropertyMatcher: ReturnType<typeof createFrontmatterPropertyExclusionMatcher>;
    hiddenFileTags: string[];
    includeDescendantNotes: boolean;
    manualSortGroupHeaderPropertyKey: string | null;
    onRefresh: () => void;
    propertyTreeService: IPropertyTreeProvider | null;
    tagTreeService: ITagTreeProvider | null;
    selectedFolder: TFolder | null;
    selectedProperty: PropertySelectionNodeId | null;
    selectedTag: string | null;
    selectionType: ItemType | null;
    settings: NotebookNavigatorSettings;
    shouldRefreshOnCustomGroupHeaderMetadataChange: boolean;
    /** Effective date visibility for the current selection, including per-selection appearance overrides */
    showFileDate: boolean;
    showHiddenItems: boolean;
    sortOption: SortOption;
    propertySortKey: string;
    propertySortSecondary: PropertySortSecondaryOption;
}

interface CustomGroupHeaderMetadataRefreshArgs {
    app: App;
    basePathSet: ReadonlySet<string>;
    cachedCustomGroupHeaderFilePaths: ReadonlySet<string>;
    customGroupHeaderFilePaths: ReadonlySet<string>;
    file: TFile;
    manualSortGroupHeaderPropertyKey: string | null;
    shouldRefreshOnCustomGroupHeaderMetadataChange: boolean;
}

export function getModifiedSortBoundaryRefreshKey(params: {
    dayKey: string;
    file: TFile;
    files: readonly TFile[];
    groupBy: ListNoteGroupingOption;
    sortOption: SortOption;
}): string | null {
    const { dayKey, file, files, groupBy, sortOption } = params;
    if (files.length === 0) {
        return null;
    }

    let boundaryFile: TFile | undefined;
    if (sortOption === 'modified-desc') {
        boundaryFile = files[0];
    } else if (sortOption === 'modified-asc') {
        boundaryFile = files[files.length - 1];
    } else {
        return null;
    }

    if (boundaryFile?.path !== file.path) {
        return null;
    }

    const dateGroupKey =
        groupBy === 'date' ? DateUtils.getDateGroupInfo(file.stat.mtime, DateUtils.parseLocalDayKey(dayKey) ?? undefined).key : 'ungrouped';

    return `${sortOption}\u0000${groupBy}\u0000${dateGroupKey}\u0000${files.length}`;
}

export function shouldSkipModifiedSortBoundaryRefresh(params: {
    previousBoundaryRefreshKey: string | undefined;
    boundaryRefreshKey: string | null;
    hasDateSearchFilters: boolean;
    showFileDate: boolean;
    showTooltips: boolean;
}): boolean {
    return (
        !params.hasDateSearchFilters &&
        !params.showFileDate &&
        !params.showTooltips &&
        params.boundaryRefreshKey !== null &&
        params.previousBoundaryRefreshKey === params.boundaryRefreshKey
    );
}

/**
 * Property filters read the storage mirror, so a matching cache write must rerun the list filter.
 * The base-path check includes files currently excluded by the filter because they may enter the result.
 */
export function hasPropertySearchContentChange(changes: readonly FileContentChange[], basePathSet: ReadonlySet<string>): boolean {
    return changes.some(change => change.changes.properties !== undefined && basePathSet.has(change.path));
}

interface ListTopologyContentChangeArgs {
    changes: readonly FileContentChange[];
    basePathSet: ReadonlySet<string>;
    hasManualSortWordCountGroupHeaders: boolean;
    hasPropertySearchFilters: boolean;
    hasTaskSearchFilters: boolean;
    hiddenFilePropertyCriteria: boolean;
    hiddenFileTags: readonly string[];
    includeDescendantNotes: boolean;
    selectedFolderPath: string | null;
    selectedProperty: PropertySelectionNodeId | null;
    selectedTag: string | null;
    selectionType: ItemType | null;
    showFileBackgroundUnfinishedTask: boolean;
    showHiddenItems: boolean;
}

/** Returns true only when cached row content can change list membership, ordering, or grouping. */
export function shouldRefreshListTopologyForContentChanges({
    changes,
    basePathSet,
    hasManualSortWordCountGroupHeaders,
    hasPropertySearchFilters,
    hasTaskSearchFilters,
    hiddenFilePropertyCriteria,
    hiddenFileTags,
    includeDescendantNotes,
    selectedFolderPath,
    selectedProperty,
    selectedTag,
    selectionType,
    showFileBackgroundUnfinishedTask,
    showHiddenItems
}: ListTopologyContentChangeArgs): boolean {
    const hasTagChanges = changes.some(change => change.changes.tags !== undefined);
    const hasPropertyChanges = changes.some(change => change.changes.properties !== undefined);
    if (hasPropertySearchFilters && hasPropertySearchContentChange(changes, basePathSet)) {
        return true;
    }

    if (hasTagChanges || hasPropertyChanges) {
        const isTagView = selectionType === ItemType.TAG && selectedTag !== null;
        const isPropertyView = selectionType === ItemType.PROPERTY && selectedProperty !== null;
        const isFolderView = selectionType === ItemType.FOLDER && selectedFolderPath !== null;
        if (isTagView && hasTagChanges) {
            return true;
        }
        if (isFolderView && hasTagChanges && selectedFolderPath !== null) {
            const shouldCheckFolderScope = hiddenFileTags.length > 0;
            if (
                changes.some(change => {
                    if (!shouldCheckFolderScope) {
                        return basePathSet.has(change.path);
                    }
                    if (selectedFolderPath === '/') {
                        return true;
                    }
                    if (!includeDescendantNotes) {
                        const separatorIndex = change.path.lastIndexOf('/');
                        const parentPath = separatorIndex === -1 ? '/' : change.path.slice(0, separatorIndex);
                        return parentPath === selectedFolderPath;
                    }
                    return change.path.startsWith(`${selectedFolderPath}/`);
                })
            ) {
                return true;
            }
        }
        if (isPropertyView) {
            if (hasPropertyChanges) {
                return true;
            }
            if (hasTagChanges) {
                const hasTagChangesInCurrentList = changes.some(change => basePathSet.has(change.path));
                const shouldRefreshForTagVisibility = hiddenFileTags.length > 0 && !showHiddenItems;
                if (hasTagChangesInCurrentList || shouldRefreshForTagVisibility) {
                    return true;
                }
            }
        }
    }

    if (hiddenFilePropertyCriteria && changes.some(change => change.metadataHiddenChanged === true && basePathSet.has(change.path))) {
        return true;
    }
    if (
        (hasTaskSearchFilters || showFileBackgroundUnfinishedTask) &&
        changes.some(change => change.changes.taskUnfinished !== undefined && basePathSet.has(change.path))
    ) {
        return true;
    }
    return (
        hasManualSortWordCountGroupHeaders &&
        changes.some(
            change => (change.changes.wordCount !== undefined || change.changes.properties !== undefined) && basePathSet.has(change.path)
        )
    );
}

interface ListTopologyVaultChangeArgs {
    basePathSet: ReadonlySet<string>;
    includeDescendantNotes: boolean;
    oldPath?: string;
    path: string;
    selectedFolderPath: string | null;
    selectionType: ItemType | null;
}

/** Filters unrelated vault events before they invalidate a folder list's derived topology. */
export function shouldRefreshListTopologyForVaultChange({
    basePathSet,
    includeDescendantNotes,
    oldPath,
    path,
    selectedFolderPath,
    selectionType
}: ListTopologyVaultChangeArgs): boolean {
    if (selectionType !== ItemType.FOLDER || selectedFolderPath === null) {
        return true;
    }

    const pathAffectsSelectedFolder = (candidatePath: string): boolean => {
        if (basePathSet.has(candidatePath) || selectedFolderPath === '/') {
            return true;
        }
        if (includeDescendantNotes) {
            return candidatePath.startsWith(`${selectedFolderPath}/`);
        }
        const separatorIndex = candidatePath.lastIndexOf('/');
        const parentPath = separatorIndex === -1 ? '/' : candidatePath.slice(0, separatorIndex);
        return parentPath === selectedFolderPath;
    };

    return pathAffectsSelectedFolder(path) || (oldPath !== undefined && pathAffectsSelectedFolder(oldPath));
}

/**
 * Current metadata detects added headers, while the rendered and count-snapshot paths detect removals
 * after the header property no longer identifies the file as an owner.
 */
export function shouldRefreshForCustomGroupHeaderMetadataChange({
    app,
    basePathSet,
    cachedCustomGroupHeaderFilePaths,
    customGroupHeaderFilePaths,
    file,
    manualSortGroupHeaderPropertyKey,
    shouldRefreshOnCustomGroupHeaderMetadataChange
}: CustomGroupHeaderMetadataRefreshArgs): boolean {
    if (
        !shouldRefreshOnCustomGroupHeaderMetadataChange ||
        manualSortGroupHeaderPropertyKey === null ||
        file.extension !== 'md' ||
        !basePathSet.has(file.path)
    ) {
        return false;
    }

    if (customGroupHeaderFilePaths.has(file.path) || cachedCustomGroupHeaderFilePaths.has(file.path)) {
        return true;
    }

    return getCachedManualSortGroupHeader(app, file, manualSortGroupHeaderPropertyKey) !== null;
}

function fileIsWithinSelectedFolder(file: TFile, includeDescendantNotes: boolean, selectedFolder: TFolder | null): boolean {
    if (!selectedFolder) {
        return false;
    }

    const fileFolder = file.parent;
    const selectedPath = selectedFolder.path;
    if (fileFolder?.path === selectedPath) {
        return true;
    }
    if (!includeDescendantNotes) {
        return false;
    }
    if (selectedPath === '/') {
        return true;
    }
    return Boolean(fileFolder?.path && fileFolder.path.startsWith(`${selectedPath}/`));
}

export function useListPaneRefresh({
    app,
    basePathSet,
    cachedCustomGroupHeaderFilePaths,
    commandQueue,
    customGroupHeaderFilePaths,
    dayKey,
    files,
    getDB,
    groupBy,
    hasDateSearchFilters,
    hasManualSortWordCountGroupHeaders,
    hasPropertySearchFilters,
    hasTaskSearchFilters,
    hiddenFilePropertyMatcher,
    hiddenFileTags,
    includeDescendantNotes,
    manualSortGroupHeaderPropertyKey,
    onRefresh,
    propertyTreeService,
    tagTreeService,
    selectedFolder,
    selectedProperty,
    selectedTag,
    selectionType,
    settings,
    shouldRefreshOnCustomGroupHeaderMetadataChange,
    showFileDate,
    showHiddenItems,
    sortOption,
    propertySortKey,
    propertySortSecondary
}: UseListPaneRefreshArgs): void {
    const onRefreshRef = useRef(onRefresh);
    const operationActiveRef = useRef(false);
    const pendingRefreshRef = useRef(false);
    const pendingImmediateRefreshRef = useRef(false);
    const modifiedSortBoundaryRefreshKeysRef = useRef<Map<string, string>>(new Map());
    const filesRef = useRef(files);

    useLayoutEffect(() => {
        filesRef.current = files;
    }, [files]);

    useEffect(() => {
        onRefreshRef.current = onRefresh;
    }, [onRefresh]);

    useEffect(() => {
        modifiedSortBoundaryRefreshKeysRef.current.clear();
        if (files.length === 0 || (sortOption !== 'modified-desc' && sortOption !== 'modified-asc')) {
            return;
        }

        const boundaryFile = sortOption === 'modified-desc' ? files[0] : files[files.length - 1];
        if (!boundaryFile) {
            return;
        }

        const boundaryRefreshKey = getModifiedSortBoundaryRefreshKey({
            dayKey,
            file: boundaryFile,
            files,
            groupBy,
            sortOption
        });
        if (boundaryRefreshKey !== null) {
            modifiedSortBoundaryRefreshKeysRef.current.set(boundaryFile.path, boundaryRefreshKey);
        }
    }, [dayKey, files, groupBy, sortOption]);

    useEffect(() => {
        const runRefresh = () => {
            pendingRefreshRef.current = false;
            pendingImmediateRefreshRef.current = false;
            onRefreshRef.current();
        };

        const scheduleRefresh = debounce(runRefresh, TIMEOUTS.FILE_OPERATION_DELAY, true);

        const hasActiveDeleteOperation = () => Boolean(commandQueue?.hasActiveOperation(OperationType.DELETE_FILES));
        const hasActiveQueuedOperation = () =>
            Boolean(commandQueue?.hasActiveOperation(OperationType.MOVE_FILE) || hasActiveDeleteOperation());
        operationActiveRef.current = hasActiveQueuedOperation();
        const isTrackedOperationActive = () => operationActiveRef.current || hasActiveQueuedOperation();

        const flushPendingWhenIdle = () => {
            if (!pendingRefreshRef.current || isTrackedOperationActive()) {
                return;
            }

            if (pendingImmediateRefreshRef.current) {
                scheduleRefresh.cancel();
                runRefresh();
                return;
            }

            scheduleRefresh();
        };

        const clearModifiedSortBoundaryRefreshKeys = () => {
            modifiedSortBoundaryRefreshKeysRef.current.clear();
        };

        const queueRefresh = (options?: { immediateWhenIdle?: boolean }) => {
            pendingRefreshRef.current = true;
            if (options?.immediateWhenIdle) {
                pendingImmediateRefreshRef.current = true;
            }

            if (isTrackedOperationActive()) {
                return;
            }

            if (pendingImmediateRefreshRef.current) {
                scheduleRefresh.cancel();
                runRefresh();
                return;
            }

            scheduleRefresh();
        };

        let unsubscribeOperationQueue: (() => void) | null = null;
        if (commandQueue) {
            unsubscribeOperationQueue = commandQueue.onOperationChange((type, active) => {
                if (type === OperationType.MOVE_FILE || type === OperationType.DELETE_FILES) {
                    operationActiveRef.current = active;
                    if (!active) {
                        flushPendingWhenIdle();
                    }
                }
            });
        }
        flushPendingWhenIdle();

        // Property and concrete tag lists collect candidate paths from their derived trees. A vault
        // rename can refresh the list before the corresponding tree replaces the old path, so the
        // tree update must trigger a second refresh or the renamed note can remain absent.
        let unsubscribePropertyTree: (() => void) | null = null;
        if (selectionType === ItemType.PROPERTY && selectedProperty && propertyTreeService) {
            unsubscribePropertyTree = propertyTreeService.addTreeUpdateListener(() => {
                queueRefresh();
            });
        }
        let unsubscribeTagTree: (() => void) | null = null;
        if (
            selectionType === ItemType.TAG &&
            selectedTag &&
            selectedTag !== TAGGED_TAG_ID &&
            selectedTag !== UNTAGGED_TAG_ID &&
            tagTreeService
        ) {
            unsubscribeTagTree = tagTreeService.addTreeUpdateListener(() => {
                queueRefresh();
            });
        }

        const shouldRefreshOnFileModify = shouldRefreshOnFileModifyForSort(sortOption, propertySortSecondary);
        // Property grouping reads frontmatter at list build time, so an edited grouping value must
        // rebuild group membership even when the active sort ignores metadata changes.
        const shouldRefreshOnMetadataChange =
            getPropertyGroupingKey(groupBy) !== null ||
            shouldRefreshOnMetadataChangeForSort({
                sortOption,
                propertySortKey,
                propertySortSecondary,
                useFrontmatterMetadata: settings.useFrontmatterMetadata,
                frontmatterNameField: settings.frontmatterNameField,
                frontmatterCreatedField: settings.frontmatterCreatedField,
                frontmatterModifiedField: settings.frontmatterModifiedField
            });

        const vaultEvents = [
            app.vault.on('create', file => {
                if (
                    file instanceof TFile &&
                    !shouldRefreshListTopologyForVaultChange({
                        basePathSet,
                        includeDescendantNotes,
                        path: file.path,
                        selectedFolderPath: selectedFolder?.path ?? null,
                        selectionType
                    })
                ) {
                    return;
                }
                clearModifiedSortBoundaryRefreshKeys();
                queueRefresh();
            }),
            app.vault.on('delete', file => {
                if (
                    file instanceof TFile &&
                    !shouldRefreshListTopologyForVaultChange({
                        basePathSet,
                        includeDescendantNotes,
                        path: file.path,
                        selectedFolderPath: selectedFolder?.path ?? null,
                        selectionType
                    })
                ) {
                    return;
                }
                clearModifiedSortBoundaryRefreshKeys();
                queueRefresh({ immediateWhenIdle: hasActiveDeleteOperation() });
            }),
            app.vault.on('rename', (file, oldPath) => {
                if (
                    file instanceof TFile &&
                    !shouldRefreshListTopologyForVaultChange({
                        basePathSet,
                        includeDescendantNotes,
                        oldPath,
                        path: file.path,
                        selectedFolderPath: selectedFolder?.path ?? null,
                        selectionType
                    })
                ) {
                    return;
                }
                clearModifiedSortBoundaryRefreshKeys();
                queueRefresh();
            }),
            app.vault.on('modify', file => {
                if (!shouldRefreshOnFileModify || !(file instanceof TFile) || !basePathSet.has(file.path)) {
                    return;
                }

                const boundaryRefreshKey = getModifiedSortBoundaryRefreshKey({
                    dayKey,
                    file,
                    files: filesRef.current,
                    groupBy,
                    sortOption
                });
                if (boundaryRefreshKey !== null) {
                    const previousBoundaryRefreshKey = modifiedSortBoundaryRefreshKeysRef.current.get(file.path);
                    modifiedSortBoundaryRefreshKeysRef.current.set(file.path, boundaryRefreshKey);
                    if (
                        shouldSkipModifiedSortBoundaryRefresh({
                            previousBoundaryRefreshKey,
                            boundaryRefreshKey,
                            hasDateSearchFilters,
                            showFileDate,
                            showTooltips: settings.showTooltips
                        })
                    ) {
                        return;
                    }
                } else {
                    modifiedSortBoundaryRefreshKeysRef.current.delete(file.path);
                }

                queueRefresh();
            })
        ];

        const metadataEvent = app.metadataCache.on('changed', file => {
            if (!(file instanceof TFile)) {
                return;
            }

            const hasHiddenPropertyStateChanged = (): boolean => {
                if (!hiddenFilePropertyMatcher.hasCriteria || file.extension !== 'md') {
                    return false;
                }

                const db = getDB();
                const record = db.getFile(file.path);
                const wasExcluded = Boolean(record?.metadata?.hidden);
                const isCurrentlyExcluded = shouldExcludeFileWithMatcher(file, hiddenFilePropertyMatcher, app);
                return isCurrentlyExcluded !== wasExcluded;
            };

            // This check must precede the selection-specific returns because cached search grouping
            // applies to every selection; otherwise tag and property events leave stale boundaries.
            if (
                shouldRefreshForCustomGroupHeaderMetadataChange({
                    app,
                    basePathSet,
                    cachedCustomGroupHeaderFilePaths,
                    customGroupHeaderFilePaths,
                    file,
                    manualSortGroupHeaderPropertyKey,
                    shouldRefreshOnCustomGroupHeaderMetadataChange
                })
            ) {
                queueRefresh();
                return;
            }

            if (selectionType === ItemType.TAG && selectedTag) {
                if (file.extension !== 'md') {
                    return;
                }

                if (!showHiddenItems && hasHiddenPropertyStateChanged()) {
                    queueRefresh();
                    return;
                }

                if (shouldRefreshOnMetadataChange && basePathSet.has(file.path)) {
                    queueRefresh();
                }
                return;
            }

            if (selectionType === ItemType.PROPERTY && selectedProperty) {
                if (file.extension !== 'md') {
                    return;
                }

                if (!showHiddenItems && hasHiddenPropertyStateChanged()) {
                    queueRefresh();
                    return;
                }

                if (shouldRefreshOnMetadataChange && basePathSet.has(file.path)) {
                    queueRefresh();
                }
                return;
            }

            if (selectionType !== ItemType.FOLDER || !fileIsWithinSelectedFolder(file, includeDescendantNotes, selectedFolder)) {
                return;
            }

            if (hiddenFilePropertyMatcher.hasCriteria && file.extension === 'md') {
                if (hasHiddenPropertyStateChanged()) {
                    queueRefresh();
                    return;
                }
            }

            if (
                hasManualSortWordCountGroupHeaders &&
                settings.wordCountTargetProperty.trim().length > 0 &&
                file.extension === 'md' &&
                basePathSet.has(file.path)
            ) {
                queueRefresh();
                return;
            }

            if (shouldRefreshOnMetadataChange && file.extension === 'md' && basePathSet.has(file.path)) {
                queueRefresh();
            }
        });

        const db = getDB();
        const dbUnsubscribe = db.onContentChange(changes => {
            if (
                shouldRefreshListTopologyForContentChanges({
                    changes,
                    basePathSet,
                    hasManualSortWordCountGroupHeaders,
                    hasPropertySearchFilters,
                    hasTaskSearchFilters,
                    hiddenFilePropertyCriteria: hiddenFilePropertyMatcher.hasCriteria,
                    hiddenFileTags,
                    includeDescendantNotes,
                    selectedFolderPath: selectedFolder?.path ?? null,
                    selectedProperty,
                    selectedTag,
                    selectionType,
                    showFileBackgroundUnfinishedTask: settings.showFileBackgroundUnfinishedTask,
                    showHiddenItems
                })
            ) {
                queueRefresh();
            }
        });

        return () => {
            vaultEvents.forEach(eventRef => app.vault.offref(eventRef));
            app.metadataCache.offref(metadataEvent);
            dbUnsubscribe();
            unsubscribeOperationQueue?.();
            unsubscribePropertyTree?.();
            unsubscribeTagTree?.();
            scheduleRefresh.cancel();
        };
    }, [
        app,
        basePathSet,
        cachedCustomGroupHeaderFilePaths,
        commandQueue,
        customGroupHeaderFilePaths,
        dayKey,
        getDB,
        groupBy,
        hasDateSearchFilters,
        hasManualSortWordCountGroupHeaders,
        hasPropertySearchFilters,
        hasTaskSearchFilters,
        hiddenFilePropertyMatcher,
        hiddenFileTags,
        includeDescendantNotes,
        manualSortGroupHeaderPropertyKey,
        propertyTreeService,
        tagTreeService,
        selectedFolder,
        selectedProperty,
        selectedTag,
        selectionType,
        shouldRefreshOnCustomGroupHeaderMetadataChange,
        settings.frontmatterCreatedField,
        settings.frontmatterModifiedField,
        settings.frontmatterNameField,
        propertySortKey,
        propertySortSecondary,
        settings.showFileBackgroundUnfinishedTask,
        showFileDate,
        settings.showTooltips,
        settings.useFrontmatterMetadata,
        settings.wordCountTargetProperty,
        showHiddenItems,
        sortOption
    ]);
}
