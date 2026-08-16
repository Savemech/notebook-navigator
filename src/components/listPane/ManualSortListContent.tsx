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

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import {
    DndContext,
    DragOverlay,
    MouseSensor,
    TouchSensor,
    type DragEndEvent,
    type DragStartEvent,
    useSensor,
    useSensors
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Menu, TFile, type App } from 'obsidian';
import { useMetadataService, useServices } from '../../context/ServicesContext';
import { useSettingsState } from '../../context/SettingsContext';
import { strings } from '../../i18n';
import type { SortOption } from '../../settings/types';
import { ListPaneItemType, type NavigationItemType } from '../../types';
import type { ListPaneItem } from '../../types/virtualization';
import type { ListPaneAppearanceSettings } from '../../settings/listPaneAppearance';
import { useManualSortKeyboard } from '../../hooks/useManualSortKeyboard';
import {
    buildManualSortFlatRows,
    clampManualSortScrollMargin,
    resolveManualSortAdjacentEntry,
    resolveManualSortFilePathAtOffset,
    resolveManualSortOffsetFromClientY,
    useManualSortVirtualization,
    type ManualSortFlatRow,
    type ManualSortFlattenSourceRow
} from './useManualSortVirtualization';
import type { FileNameIconNeedle } from '../../utils/fileIconUtils';
import type { FileItemPillDecorationModel } from '../../utils/fileItemPillDecoration';
import type { FileItemPillOrderModel } from '../../utils/fileItemPillOrder';
import type { FolderDecorationModel } from '../../utils/folderDecoration';
import type { HiddenTagVisibility } from '../../utils/tagPrefixMatcher';
import { typeFilteredCollisionDetection, verticalAxisOnly } from '../../utils/dndConfig';
import {
    getCachedManualSortGroupHeader,
    getManualSortSelectedMarkdownPaths,
    moveManualSortMarkdownFiles,
    normalizeManualSortGroupHeaderWordCount,
    partitionManualSortFiles,
    shouldShowManualSortGroupHeaderProgress,
    shouldShowManualSortGroupHeaderWordCount,
    type ManualSortGroupHeaderData
} from '../../utils/manualSort';
import { hasSolidFileRowBackground } from '../../utils/colorUtils';
import { addManualSortGroupHeaderMenuItems } from '../../utils/contextMenu/manualSortGroupHeaderMenuItems';
import { getCachedWordCountTargetFromFrontmatter, getWordCountTargetFromProperties } from '../../utils/wordCountUtils';
import { ObsidianIcon } from '../ObsidianIcon';
import { FileItem, type FileItemPaneProps, type FileItemStorageHelpers } from '../FileItem';
import { ManualSortGroupHeaderContent, ManualSortGroupHeaderProgress } from './ManualSortGroupHeaderContent';

const MANUAL_SORT_MOUSE_CONSTRAINT = { distance: 2 };
const MANUAL_SORT_TOUCH_CONSTRAINT = { distance: 4 };

interface ManualSortFileInfo {
    fileIndex?: number;
    parentFolder?: string | null;
    isHidden?: boolean;
}

interface ManualSortListContentProps {
    files: TFile[];
    listItems: ListPaneItem[];
    hiddenFileState: ReadonlyMap<string, boolean>;
    propertyKey: string;
    manualSortGroupHeaderPropertyKey: string | null;
    wordCountTargetProperty: string;
    rankByPath: ReadonlyMap<string, number>;
    selectedFolderPath: string | null;
    isSaving: boolean;
    isDoneDisabled: boolean;
    selectionType: NavigationItemType | null;
    sortOption?: SortOption;
    localDayReference: Date | null;
    fileIconSize: number;
    appearanceSettings: ListPaneAppearanceSettings;
    includeDescendantNotes: boolean;
    hiddenTagVisibility: HiddenTagVisibility;
    fileNameIconNeedles: readonly FileNameIconNeedle[];
    visibleListPropertyKeys: ReadonlySet<string>;
    visibleNavigationPropertyKeys: ReadonlySet<string>;
    fileItemStorage: FileItemStorageHelpers;
    noteShortcutKeysByPath: ReadonlyMap<string, string>;
    folderDecorationModel: FolderDecorationModel;
    fileItemPillDecorationModel: FileItemPillDecorationModel;
    fileItemPillOrderModel: FileItemPillOrderModel;
    getSolidBackground: (color?: string | null) => string | undefined;
    selectedFiles: ReadonlySet<string>;
    selectedFilePath: string | null;
    onFileClick: (file: TFile, fileIndex: number | undefined, event: ReactMouseEvent) => void;
    onKeyboardSelect: (file: TFile, options?: { debounceOpen?: boolean }) => void;
    onScheduleKeyboardOpen?: () => void;
    onScheduleKeyboardOpenForFile?: (file: TFile) => void;
    onCommitKeyboardOpen?: () => void;
    onDone: () => void;
    onReorder: (params: { nextFiles: TFile[]; movedPaths: ReadonlySet<string>; onApplied?: () => void }) => void;
}

interface ManualSortEntry {
    file: TFile;
    sortableId: string;
    info: ManualSortFileInfo;
}

interface ManualSortRenderRow {
    key: string;
    entry: ManualSortEntry;
    segmentKey: string;
    header?: ManualSortGroupHeaderData;
    headerWordCount?: number;
    headerTargetWordCount?: number | null;
    headerFilePath?: string;
}

interface ManualSortRowContext {
    isMobile: boolean;
    paneProps: FileItemPaneProps;
}

interface ManualSortRowProps extends ManualSortRowContext {
    entry: ManualSortEntry;
    isLastEntry: boolean;
    canReorder: boolean;
    isSelected: boolean;
    hasSelectedAbove: boolean;
    hasSelectedBelow: boolean;
    isDragBlockMember: boolean;
    hideSeparator: boolean;
    hasCustomBackground: boolean;
    hasPreviousCustomBackground: boolean;
    hasNextCustomBackground: boolean;
    hasFilledBackground: boolean;
    hasPreviousFilledBackground: boolean;
    hasNextFilledBackground: boolean;
    header?: ManualSortGroupHeaderData;
    headerWordCount?: number;
    headerTargetWordCount?: number | null;
    headerFilePath?: string;
    suppressHeaderTopSpacing?: boolean;
    shortcutKey?: string;
}

function getManualSortRowClassName({
    canReorder,
    isDragBlockMember,
    isSorting = false,
    isLastEntry,
    hideSeparator,
    hasCustomBackground,
    hasPreviousCustomBackground,
    hasNextCustomBackground,
    hasFilledBackground,
    hasPreviousFilledBackground,
    hasNextFilledBackground
}: Pick<
    ManualSortRowProps,
    | 'canReorder'
    | 'isDragBlockMember'
    | 'isLastEntry'
    | 'hideSeparator'
    | 'hasCustomBackground'
    | 'hasPreviousCustomBackground'
    | 'hasNextCustomBackground'
    | 'hasFilledBackground'
    | 'hasPreviousFilledBackground'
    | 'hasNextFilledBackground'
> & {
    isSorting?: boolean;
}): string {
    const classes = ['nn-manual-sort-row', canReorder ? 'nn-manual-sort-row-draggable' : 'nn-manual-sort-row-disabled'];
    if (isDragBlockMember) classes.push('nn-manual-sort-row-drag-block');
    if (isSorting) classes.push('nn-manual-sort-row-sorting');
    if (isLastEntry) classes.push('nn-manual-sort-row-last');
    if (hideSeparator) classes.push('nn-manual-sort-row-hide-separator');
    if (hasFilledBackground) classes.push('nn-manual-sort-row-has-filled-background');
    if (hasPreviousFilledBackground) classes.push('nn-manual-sort-row-has-filled-background-previous');
    if (hasNextFilledBackground) classes.push('nn-manual-sort-row-has-filled-background-next');
    if (hasCustomBackground) classes.push('nn-manual-sort-row-has-custom-background');
    if (hasPreviousCustomBackground) classes.push('nn-manual-sort-row-has-custom-background-previous');
    if (hasNextCustomBackground) classes.push('nn-manual-sort-row-has-custom-background-next');
    return classes.join(' ');
}

function noopModifySearch(): void {
    return;
}

async function noopToggleShortcut(): Promise<void> {
    return;
}

function ManualSortRowContent({
    entry,
    canReorder,
    isMobile,
    paneProps,
    shortcutKey,
    isSelected,
    hasSelectedAbove,
    hasSelectedBelow,
    dragHandle
}: ManualSortRowProps & { dragHandle?: ReactNode }) {
    return (
        <>
            <div className="nn-manual-sort-file">
                <FileItem
                    file={entry.file}
                    paneProps={paneProps}
                    isSelected={isSelected}
                    hasSelectedAbove={hasSelectedAbove}
                    hasSelectedBelow={hasSelectedBelow}
                    showQuickActionsPanel={false}
                    fileIndex={entry.info.fileIndex}
                    parentFolder={entry.info.parentFolder}
                    isPinned={false}
                    isHidden={entry.info.isHidden}
                    shortcutKey={shortcutKey}
                    manualSortDisabled={!canReorder}
                />
            </div>
            {isMobile && canReorder ? dragHandle : null}
        </>
    );
}

function ManualSortCustomHeader({
    header,
    headerWordCount,
    headerTargetWordCount,
    headerFilePath,
    suppressHeaderTopSpacing
}: {
    header: ManualSortGroupHeaderData;
    headerWordCount?: number;
    headerTargetWordCount?: number | null;
    headerFilePath?: string;
    suppressHeaderTopSpacing?: boolean;
}) {
    const hasManualSortGoal = shouldShowManualSortGroupHeaderProgress(header, headerTargetWordCount);
    return hasManualSortGoal ? (
        <div
            className={`nn-manual-sort-group-header-shell nn-manual-sort-custom-header${
                suppressHeaderTopSpacing ? '' : ' nn-manual-sort-section-header'
            }`}
            data-manual-sort-header-file-path={headerFilePath}
        >
            <div className="nn-list-group-header nn-list-group-header--manual-sort">
                <ManualSortGroupHeaderContent header={header} wordCount={headerWordCount ?? 0} targetWordCount={headerTargetWordCount} />
            </div>
            <ManualSortGroupHeaderProgress header={header} wordCount={headerWordCount ?? 0} targetWordCount={headerTargetWordCount} />
        </div>
    ) : (
        <div
            className={`nn-list-group-header nn-list-group-header--manual-sort nn-manual-sort-custom-header${
                suppressHeaderTopSpacing ? '' : ' nn-manual-sort-section-header'
            }`}
            data-manual-sort-header-file-path={headerFilePath}
        >
            <ManualSortGroupHeaderContent header={header} wordCount={headerWordCount ?? 0} targetWordCount={headerTargetWordCount} />
        </div>
    );
}

function SortableManualSortRow(props: ManualSortRowProps) {
    const {
        entry,
        isLastEntry,
        canReorder,
        isMobile,
        isDragBlockMember,
        hideSeparator,
        hasCustomBackground,
        hasPreviousCustomBackground,
        hasNextCustomBackground,
        hasFilledBackground,
        hasPreviousFilledBackground,
        hasNextFilledBackground,
        headerFilePath,
        header,
        headerWordCount,
        headerTargetWordCount,
        suppressHeaderTopSpacing
    } = props;
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isSorting, isDragging } = useSortable({
        id: entry.sortableId,
        disabled: !canReorder,
        data: { type: 'manual-sort-file' }
    });
    const dragStyle = {
        transform: transform ? CSS.Translate.toString(transform) : undefined,
        transition,
        opacity: isDragging ? 0 : undefined
    };
    const bindRowDrag = canReorder && !isMobile;
    const bindHandleDrag = canReorder && isMobile;

    const dragHandle = (
        <span
            ref={setActivatorNodeRef}
            className="nn-drag-handle"
            role="button"
            tabIndex={-1}
            {...(bindHandleDrag ? attributes : undefined)}
            {...(bindHandleDrag ? listeners : undefined)}
        >
            <ObsidianIcon name="lucide-grip-horizontal" />
        </span>
    );

    return (
        <div
            ref={setNodeRef}
            className={`nn-manual-sort-sortable-item${isSorting ? ' nn-manual-sort-sortable-item-sorting' : ''}`}
            style={dragStyle}
        >
            {header ? (
                <ManualSortCustomHeader
                    header={header}
                    headerWordCount={headerWordCount}
                    headerTargetWordCount={headerTargetWordCount}
                    headerFilePath={headerFilePath}
                    suppressHeaderTopSpacing={suppressHeaderTopSpacing}
                />
            ) : null}
            <div
                className={getManualSortRowClassName({
                    canReorder,
                    isDragBlockMember,
                    isSorting,
                    isLastEntry,
                    hideSeparator,
                    hasCustomBackground,
                    hasPreviousCustomBackground,
                    hasNextCustomBackground,
                    hasFilledBackground,
                    hasPreviousFilledBackground,
                    hasNextFilledBackground
                })}
                {...(bindRowDrag ? attributes : undefined)}
                {...(bindRowDrag ? listeners : undefined)}
            >
                <ManualSortRowContent {...props} dragHandle={dragHandle} />
            </div>
        </div>
    );
}

function ManualSortStaticRow(props: ManualSortRowProps) {
    const {
        isLastEntry,
        isDragBlockMember,
        hideSeparator,
        hasCustomBackground,
        hasPreviousCustomBackground,
        hasNextCustomBackground,
        hasFilledBackground,
        hasPreviousFilledBackground,
        hasNextFilledBackground
    } = props;

    return (
        <div
            className={getManualSortRowClassName({
                canReorder: false,
                isDragBlockMember,
                isLastEntry,
                hideSeparator,
                hasCustomBackground,
                hasPreviousCustomBackground,
                hasNextCustomBackground,
                hasFilledBackground,
                hasPreviousFilledBackground,
                hasNextFilledBackground
            })}
        >
            <ManualSortRowContent {...props} canReorder={false} />
        </div>
    );
}

function buildManualSortRenderRows(
    app: App,
    entries: readonly ManualSortEntry[],
    groupHeaderPropertyKey: string | null,
    sectionKey: string,
    getWordCount: (file: TFile) => number,
    getWordCountTarget: (file: TFile) => number | null
): ManualSortRenderRow[] {
    const rows: ManualSortRenderRow[] = [];
    let segmentIndex = 0;
    let activeHeaderRow: ManualSortRenderRow | null = null;
    let activeHeader: ManualSortGroupHeaderData | null = null;
    let activeWordCount = 0;
    let activeTargetWordCount: number | null = null;
    const updateActiveHeaderWordCount = (): void => {
        if (!activeHeaderRow || !activeHeader) {
            return;
        }

        activeHeaderRow.headerWordCount = activeWordCount;
        activeHeaderRow.headerTargetWordCount = activeTargetWordCount;
    };

    entries.forEach(entry => {
        let headerData: ManualSortGroupHeaderData | undefined;
        if (groupHeaderPropertyKey && entry.file.extension === 'md') {
            const header = getCachedManualSortGroupHeader(app, entry.file, groupHeaderPropertyKey);
            if (header) {
                segmentIndex += 1;
                headerData = header;
                activeHeader = header;
                activeWordCount = 0;
                activeTargetWordCount = header.targetWordCount;
            }
        }

        const row: ManualSortRenderRow = {
            key: entry.sortableId,
            entry,
            segmentKey: `${sectionKey}:${segmentIndex}`,
            header: headerData
        };
        rows.push(row);
        if (activeHeader && headerData) {
            activeHeaderRow = row;
            activeHeaderRow.headerFilePath = entry.file.path;
            updateActiveHeaderWordCount();
        }
        if (activeHeader && shouldShowManualSortGroupHeaderWordCount(activeHeader) && entry.file.extension === 'md') {
            activeWordCount += getWordCount(entry.file);
            if (activeHeader.targetWordCount === null) {
                const fileTargetWordCount = getWordCountTarget(entry.file);
                if (fileTargetWordCount !== null) {
                    activeTargetWordCount = (activeTargetWordCount ?? 0) + fileTargetWordCount;
                }
            }
            updateActiveHeaderWordCount();
        }
    });

    return rows;
}

interface ManualSortGroupProps {
    rankedRows: ManualSortRenderRow[];
    unsortedRows: ManualSortRenderRow[];
    nonMarkdownRows: ManualSortRenderRow[];
    canReorder: boolean;
    rowContext: ManualSortRowContext;
    noteShortcutKeysByPath: ReadonlyMap<string, string>;
    selectedFiles: ReadonlySet<string>;
    activeDragPaths: ReadonlySet<string>;
    activeDragPath: string | null;
    scrollContainerRef: React.RefObject<HTMLDivElement>;
    scrollToFilePathRef: React.MutableRefObject<((filePath: string) => boolean) | null>;
    resolveDropPathAtClientYRef: React.MutableRefObject<((clientY: number) => string | null) | null>;
}

interface ManualSortFlatHeader {
    row: ManualSortRenderRow;
    suppressTopSpacing: boolean;
}

type ManualSortFlatSourceRow = ManualSortFlattenSourceRow<ManualSortRenderRow, ManualSortFlatHeader> & {
    section: 'ranked' | 'unsorted' | 'non-markdown';
};
type ManualSortVirtualRow = ManualSortFlatRow<ManualSortRenderRow, ManualSortFlatHeader>;

function ManualSortGroup({
    rankedRows,
    unsortedRows,
    nonMarkdownRows,
    canReorder,
    rowContext,
    noteShortcutKeysByPath,
    selectedFiles,
    activeDragPaths,
    activeDragPath,
    scrollContainerRef,
    scrollToFilePathRef,
    resolveDropPathAtClientYRef
}: ManualSortGroupProps) {
    const { fileItemStorage, getSolidBackground } = rowContext.paneProps;
    const settings = useSettingsState();
    const metadataService = useMetadataService();
    const buildFlatSources = useCallback(
        (
            rows: readonly ManualSortRenderRow[],
            suppressFirstHeaderSpacing: boolean,
            section: ManualSortFlatSourceRow['section']
        ): ManualSortFlatSourceRow[] =>
            rows.map((row, index) => ({
                key: row.key,
                filePath: row.entry.file.path,
                entry: row,
                sortable: row.entry.file.extension === 'md',
                header: row.header ? { row, suppressTopSpacing: suppressFirstHeaderSpacing && index === 0 } : undefined,
                section
            })),
        []
    );
    const rankedSources = useMemo(() => buildFlatSources(rankedRows, true, 'ranked'), [buildFlatSources, rankedRows]);
    const unsortedSources = useMemo(() => buildFlatSources(unsortedRows, false, 'unsorted'), [buildFlatSources, unsortedRows]);
    const nonMarkdownSources = useMemo(() => buildFlatSources(nonMarkdownRows, false, 'non-markdown'), [buildFlatSources, nonMarkdownRows]);
    const flatModel = useMemo(
        () =>
            buildManualSortFlatRows({
                rankedRows: rankedSources,
                unsortedRows: unsortedSources,
                nonMarkdownRows: nonMarkdownSources
            }),
        [nonMarkdownSources, rankedSources, unsortedSources]
    );
    const logicalSources = useMemo(
        () => [...rankedSources, ...unsortedSources, ...nonMarkdownSources],
        [nonMarkdownSources, rankedSources, unsortedSources]
    );
    const sourceIndexByPath = useMemo(() => new Map(logicalSources.map((source, index) => [source.filePath, index])), [logicalSources]);
    const listRef = useRef<HTMLDivElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);
    useLayoutEffect(() => {
        const listElement = listRef.current;
        const scrollElement = scrollContainerRef.current;
        if (!listElement || !scrollElement) {
            return;
        }
        const measureScrollMargin = () => {
            const nextMargin =
                listElement.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
            const clampedMargin = clampManualSortScrollMargin(nextMargin);
            setScrollMargin(current => (current === clampedMargin ? current : clampedMargin));
        };
        measureScrollMargin();
        const targetWindow = listElement.ownerDocument.defaultView;
        const ResizeObserverConstructor = (targetWindow as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver;
        if (typeof ResizeObserverConstructor !== 'function') {
            return;
        }
        const resizeObserver = new ResizeObserverConstructor(measureScrollMargin);
        resizeObserver.observe(scrollElement);
        const headerElement = scrollElement.querySelector('.nn-manual-sort-header');
        if (headerElement) {
            resizeObserver.observe(headerElement);
        }
        return () => resizeObserver.disconnect();
    }, [flatModel.rows.length, scrollContainerRef]);
    const rowVirtualizer = useManualSortVirtualization({
        rows: flatModel.rows,
        scrollContainerRef,
        scrollMargin,
        pinnedIndex: activeDragPath ? flatModel.fileIndexByPath.get(activeDragPath) : undefined
    });
    useLayoutEffect(() => {
        const scrollToFilePath = (filePath: string): boolean => {
            const index = flatModel.fileIndexByPath.get(filePath);
            if (index === undefined) {
                return false;
            }
            rowVirtualizer.scrollToIndex(index, { align: 'auto' });
            return true;
        };
        scrollToFilePathRef.current = scrollToFilePath;
        return () => {
            if (scrollToFilePathRef.current === scrollToFilePath) {
                scrollToFilePathRef.current = null;
            }
        };
    }, [flatModel.fileIndexByPath, rowVirtualizer, scrollToFilePathRef]);
    useLayoutEffect(() => {
        const resolveDropPathAtClientY = (clientY: number): string | null => {
            const scrollElement = scrollContainerRef.current;
            const listElement = listRef.current;
            if (!scrollElement || !listElement) {
                return null;
            }
            const offset = resolveManualSortOffsetFromClientY(clientY, listElement.getBoundingClientRect().top, scrollMargin);
            return resolveManualSortFilePathAtOffset(flatModel.rows, rowVirtualizer.getVirtualItems(), offset, targetOffset =>
                rowVirtualizer.getVirtualItemForOffset(targetOffset)
            );
        };
        resolveDropPathAtClientYRef.current = resolveDropPathAtClientY;
        return () => {
            if (resolveDropPathAtClientYRef.current === resolveDropPathAtClientY) {
                resolveDropPathAtClientYRef.current = null;
            }
        };
    }, [flatModel.rows, resolveDropPathAtClientYRef, rowVirtualizer, scrollContainerRef, scrollMargin]);
    const backgroundCache = new Map<string, boolean>();
    const hasFileBackground = (entry: ManualSortEntry | undefined): boolean => {
        if (!entry) {
            return false;
        }

        const cached = backgroundCache.get(entry.file.path);
        if (cached !== undefined) {
            return cached;
        }

        const taskUnfinished = settings.showFileBackgroundUnfinishedTask
            ? fileItemStorage.getDB().getFile(entry.file.path)?.taskUnfinished
            : undefined;
        const hasBackground = hasSolidFileRowBackground({
            customBackgroundColor: metadataService.getFileBackgroundColor(entry.file.path),
            taskUnfinished,
            showUnfinishedTaskBackground: settings.showFileBackgroundUnfinishedTask,
            unfinishedTaskBackgroundColor: settings.unfinishedTaskBackgroundColor,
            getSolidBackground
        });
        backgroundCache.set(entry.file.path, hasBackground);
        return hasBackground;
    };
    const renderVirtualRow = (virtualRow: ManualSortVirtualRow): ReactNode => {
        if (virtualRow.kind === 'section-header') {
            return (
                <div className={`nn-list-group-header${virtualRow.suppressTopSpacing ? '' : ' nn-manual-sort-section-header'}`}>
                    <span className="nn-list-group-header-text">{strings.listPane.unsortedSection}</span>
                </div>
            );
        }
        const row = virtualRow.entry;
        const entry = row.entry;
        const sourceIndex = sourceIndexByPath.get(entry.file.path) ?? -1;
        const previousRow = resolveManualSortAdjacentEntry(logicalSources, sourceIndex, -1);
        const nextRow = resolveManualSortAdjacentEntry(logicalSources, sourceIndex, 1);
        const previousEntry = previousRow?.segmentKey === row.segmentKey ? previousRow.entry : undefined;
        const nextEntry = nextRow?.segmentKey === row.segmentKey ? nextRow.entry : undefined;
        const isLastEntry = !nextEntry;
        const isSelected = selectedFiles.has(entry.file.path);
        const isNextSelected = nextEntry ? selectedFiles.has(nextEntry.file.path) : false;
        const isPreviousSelected = previousEntry ? selectedFiles.has(previousEntry.file.path) : false;
        const entryHasCustomBackground = hasFileBackground(entry);
        const previousEntryHasBackground = hasFileBackground(previousEntry);
        const nextEntryHasBackground = hasFileBackground(nextEntry);
        const previousEntryHasCustomBackground = entryHasCustomBackground && previousEntryHasBackground;
        const nextEntryHasCustomBackground = nextEntryHasBackground;
        const entryHasFilledBackground = isSelected || entryHasCustomBackground;
        const previousEntryHasFilledBackground =
            entryHasFilledBackground && Boolean(previousEntry && (isPreviousSelected || previousEntryHasBackground));
        const nextEntryHasFilledBackground = entryHasFilledBackground && Boolean(nextEntry && (isNextSelected || nextEntryHasBackground));
        const rowProps: ManualSortRowProps = {
            ...rowContext,
            entry,
            isLastEntry,
            canReorder: canReorder && entry.file.extension === 'md',
            isSelected,
            hasSelectedAbove: Boolean(previousEntry && selectedFiles.has(previousEntry.file.path)),
            hasSelectedBelow: Boolean(nextEntry && selectedFiles.has(nextEntry.file.path)),
            isDragBlockMember: activeDragPaths.has(entry.file.path),
            hideSeparator: (isSelected && !isNextSelected) || (!isSelected && isNextSelected),
            hasCustomBackground: entryHasCustomBackground,
            hasPreviousCustomBackground: previousEntryHasCustomBackground,
            hasNextCustomBackground: nextEntryHasCustomBackground,
            hasFilledBackground: entryHasFilledBackground,
            hasPreviousFilledBackground: previousEntryHasFilledBackground,
            hasNextFilledBackground: nextEntryHasFilledBackground,
            shortcutKey: noteShortcutKeysByPath.get(entry.file.path),
            header: row.header,
            headerWordCount: row.headerWordCount,
            headerTargetWordCount: row.headerTargetWordCount,
            headerFilePath: row.headerFilePath,
            suppressHeaderTopSpacing: virtualRow.source.header?.suppressTopSpacing
        };

        if (entry.file.extension !== 'md') {
            return <ManualSortStaticRow {...rowProps} />;
        }

        return <SortableManualSortRow {...rowProps} />;
    };

    return (
        <SortableContext items={flatModel.sortableIds} strategy={verticalListSortingStrategy}>
            <div
                ref={listRef}
                className="nn-manual-sort-list"
                style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}
            >
                {rowVirtualizer.getVirtualItems().map(virtualItem => {
                    const row = flatModel.rows[virtualItem.index];
                    if (!row) {
                        return null;
                    }
                    return (
                        <div
                            key={row.key}
                            ref={rowVirtualizer.measureElement}
                            data-index={virtualItem.index}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                transform: `translateY(${virtualItem.start - scrollMargin}px)`
                            }}
                        >
                            {renderVirtualRow(row)}
                        </div>
                    );
                })}
            </div>
        </SortableContext>
    );
}

function buildFileInfoMap(listItems: readonly ListPaneItem[]): Map<string, ManualSortFileInfo> {
    const map = new Map<string, ManualSortFileInfo>();
    listItems.forEach(item => {
        if (item.type !== ListPaneItemType.FILE || !(item.data instanceof TFile)) {
            return;
        }

        map.set(item.data.path, {
            fileIndex: item.fileIndex,
            parentFolder: item.parentFolder,
            isHidden: item.isHidden
        });
    });
    return map;
}

export function ManualSortListContent({
    files,
    listItems,
    hiddenFileState,
    propertyKey,
    manualSortGroupHeaderPropertyKey,
    wordCountTargetProperty,
    rankByPath,
    selectedFolderPath,
    isSaving,
    isDoneDisabled,
    selectionType,
    sortOption,
    localDayReference,
    fileIconSize,
    appearanceSettings,
    includeDescendantNotes,
    hiddenTagVisibility,
    fileNameIconNeedles,
    visibleListPropertyKeys,
    visibleNavigationPropertyKeys,
    fileItemStorage,
    noteShortcutKeysByPath,
    folderDecorationModel,
    fileItemPillDecorationModel,
    fileItemPillOrderModel,
    getSolidBackground,
    selectedFiles,
    selectedFilePath,
    onFileClick,
    onKeyboardSelect,
    onScheduleKeyboardOpen,
    onScheduleKeyboardOpenForFile,
    onCommitKeyboardOpen,
    onDone,
    onReorder
}: ManualSortListContentProps) {
    const { app, isMobile } = useServices();
    const metadataService = useMetadataService();
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const scrollToFilePathRef = useRef<((filePath: string) => boolean) | null>(null);
    const resolveDropPathAtClientYRef = useRef<((clientY: number) => string | null) | null>(null);
    const [activeDragPaths, setActiveDragPaths] = useState<ReadonlySet<string>>(() => new Set());
    const [activeDragPath, setActiveDragPath] = useState<string | null>(null);
    const fileInfoByPath = useMemo(() => buildFileInfoMap(listItems), [listItems]);
    const filePartitions = useMemo(() => partitionManualSortFiles(files), [files]);
    const markdownFiles = filePartitions.markdown;
    const nonMarkdownFiles = filePartitions.nonMarkdown;
    const manualFileIndexByPath = useMemo(() => new Map(files.map((file, index) => [file.path, index])), [files]);
    const rankedMarkdownFiles = useMemo(() => markdownFiles.filter(file => rankByPath.has(file.path)), [markdownFiles, rankByPath]);
    const unsortedMarkdownFiles = useMemo(() => markdownFiles.filter(file => !rankByPath.has(file.path)), [markdownFiles, rankByPath]);
    const nonMarkdownCount = nonMarkdownFiles.length;
    const hasNoFiles = files.length === 0;

    const buildEntries = useCallback(
        (sourceFiles: TFile[]): ManualSortEntry[] =>
            sourceFiles.map(file => {
                const info = fileInfoByPath.get(file.path) ?? {};
                return {
                    file,
                    sortableId: file.path,
                    info: {
                        ...info,
                        fileIndex: manualFileIndexByPath.get(file.path) ?? info.fileIndex,
                        parentFolder: info.parentFolder ?? selectedFolderPath,
                        isHidden: info.isHidden ?? hiddenFileState.get(file.path)
                    }
                };
            }),
        [fileInfoByPath, hiddenFileState, manualFileIndexByPath, selectedFolderPath]
    );
    const rankedEntries = useMemo<ManualSortEntry[]>(() => buildEntries(rankedMarkdownFiles), [buildEntries, rankedMarkdownFiles]);
    const unsortedEntries = useMemo<ManualSortEntry[]>(() => buildEntries(unsortedMarkdownFiles), [buildEntries, unsortedMarkdownFiles]);
    const nonMarkdownEntries = useMemo<ManualSortEntry[]>(() => buildEntries(nonMarkdownFiles), [buildEntries, nonMarkdownFiles]);
    const getWordCount = useCallback(
        (file: TFile): number => {
            return normalizeManualSortGroupHeaderWordCount(fileItemStorage.getDB().getFile(file.path)?.wordCount);
        },
        [fileItemStorage]
    );
    const getWordCountTarget = useCallback(
        (file: TFile): number | null => {
            return (
                getWordCountTargetFromProperties(fileItemStorage.getDB().getFile(file.path)?.properties, wordCountTargetProperty) ??
                getCachedWordCountTargetFromFrontmatter(app, file, wordCountTargetProperty)
            );
        },
        [app, fileItemStorage, wordCountTargetProperty]
    );
    const rankedRows = useMemo(
        () => buildManualSortRenderRows(app, rankedEntries, manualSortGroupHeaderPropertyKey, 'ranked', getWordCount, getWordCountTarget),
        [app, getWordCount, getWordCountTarget, manualSortGroupHeaderPropertyKey, rankedEntries]
    );
    const unsortedRows = useMemo(
        () =>
            buildManualSortRenderRows(app, unsortedEntries, manualSortGroupHeaderPropertyKey, 'unsorted', getWordCount, getWordCountTarget),
        [app, getWordCount, getWordCountTarget, manualSortGroupHeaderPropertyKey, unsortedEntries]
    );
    const nonMarkdownRows = useMemo(
        () => buildManualSortRenderRows(app, nonMarkdownEntries, null, 'non-markdown', getWordCount, getWordCountTarget),
        [app, getWordCount, getWordCountTarget, nonMarkdownEntries]
    );
    const entries = useMemo<ManualSortEntry[]>(() => {
        return [...rankedEntries, ...unsortedEntries, ...nonMarkdownEntries];
    }, [nonMarkdownEntries, rankedEntries, unsortedEntries]);
    const sortableRegistry = useMemo(() => {
        return new Map(entries.map(entry => [entry.sortableId, entry]));
    }, [entries]);
    const dragReorderStateRef = useRef({ files, markdownFiles, selectedFiles, sortableRegistry, isSaving, onReorder });
    useLayoutEffect(() => {
        dragReorderStateRef.current = { files, markdownFiles, selectedFiles, sortableRegistry, isSaving, onReorder };
    }, [files, isSaving, markdownFiles, onReorder, selectedFiles, sortableRegistry]);
    const activeDragEntry = activeDragPath ? sortableRegistry.get(activeDragPath) : undefined;

    const paneProps = useMemo<FileItemPaneProps>(
        () => ({
            onFileClick,
            selectionType,
            sortOption,
            onModifySearchWithTag: noopModifySearch,
            onModifySearchWithProperty: noopModifySearch,
            localDayReference,
            fileIconSize,
            appearanceSettings,
            includeDescendantNotes,
            hiddenTagVisibility,
            fileNameIconNeedles,
            visiblePropertyKeys: visibleListPropertyKeys,
            visibleNavigationPropertyKeys,
            fileItemStorage,
            onToggleNoteShortcut: noopToggleShortcut,
            folderDecorationModel,
            fileItemPillDecorationModel,
            fileItemPillOrderModel,
            getSolidBackground,
            disableNativeDrag: true
        }),
        [
            onFileClick,
            selectionType,
            sortOption,
            localDayReference,
            fileIconSize,
            appearanceSettings,
            includeDescendantNotes,
            hiddenTagVisibility,
            fileNameIconNeedles,
            visibleListPropertyKeys,
            visibleNavigationPropertyKeys,
            fileItemStorage,
            folderDecorationModel,
            fileItemPillDecorationModel,
            fileItemPillOrderModel,
            getSolidBackground
        ]
    );

    const rowContext = useMemo<ManualSortRowContext>(() => ({ isMobile, paneProps }), [isMobile, paneProps]);

    const getDragBlockPaths = useCallback(
        (activePath: string): ReadonlySet<string> => {
            const selectedMarkdownPaths = getManualSortSelectedMarkdownPaths(markdownFiles, activePath, selectedFiles);
            return selectedMarkdownPaths.size > 1 ? selectedMarkdownPaths : new Set();
        },
        [markdownFiles, selectedFiles]
    );

    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: MANUAL_SORT_MOUSE_CONSTRAINT }),
        useSensor(TouchSensor, { activationConstraint: MANUAL_SORT_TOUCH_CONSTRAINT })
    );
    const scrollToFilePath = useCallback((filePath: string) => scrollToFilePathRef.current?.(filePath) ?? false, []);

    const { handleKeyDown, handleKeyUp } = useManualSortKeyboard({
        scrollContainerRef,
        files,
        markdownFiles,
        selectedFiles,
        selectedFilePath,
        isSaving,
        scrollToFilePath,
        onKeyboardSelect,
        onScheduleKeyboardOpen,
        onScheduleKeyboardOpenForFile,
        onCommitKeyboardOpen,
        onReorder
    });

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        setActiveDragPaths(new Set());
        setActiveDragPath(null);
        const reorderState = dragReorderStateRef.current;
        if (reorderState.isSaving) {
            return;
        }

        const activeId = event.active.id as string;
        const translatedRect = event.active.rect.current.translated;
        const fallbackOverPath = translatedRect
            ? resolveDropPathAtClientYRef.current?.(translatedRect.top + translatedRect.height / 2)
            : null;
        const overId = (event.over?.id as string | undefined) ?? fallbackOverPath ?? undefined;
        if (!overId || activeId === overId) {
            return;
        }

        const active = reorderState.sortableRegistry.get(activeId);
        const over = reorderState.sortableRegistry.get(overId);
        if (!active || !over || active.file.extension !== 'md' || over.file.extension !== 'md') {
            return;
        }

        const nextFiles = moveManualSortMarkdownFiles(reorderState.files, active.file.path, over.file.path, reorderState.selectedFiles);
        if (!nextFiles) {
            return;
        }

        const selectedMarkdownPaths = getManualSortSelectedMarkdownPaths(
            reorderState.markdownFiles,
            active.file.path,
            reorderState.selectedFiles
        );
        reorderState.onReorder({
            nextFiles,
            movedPaths: selectedMarkdownPaths.size > 1 ? selectedMarkdownPaths : new Set([active.file.path])
        });
    }, []);

    const handleDragStart = useCallback(
        (event: DragStartEvent) => {
            if (isSaving) {
                return;
            }

            const activeId = event.active.id as string;
            setActiveDragPath(activeId);
            setActiveDragPaths(getDragBlockPaths(activeId));
        },
        [getDragBlockPaths, isSaving]
    );

    const handleDragCancel = useCallback(() => {
        setActiveDragPaths(new Set());
        setActiveDragPath(null);
    }, []);
    const handleContextMenu = useCallback(
        (event: ReactMouseEvent<HTMLDivElement>) => {
            if (!manualSortGroupHeaderPropertyKey) {
                return;
            }

            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            let filePath: string | undefined;
            const headerElement = target.closest('.nn-manual-sort-custom-header');
            if (headerElement instanceof HTMLElement) {
                filePath = headerElement.dataset.manualSortHeaderFilePath;
            }

            if (!filePath) {
                const fileElement = target.closest('.nn-file');
                if (!(fileElement instanceof HTMLElement)) {
                    return;
                }
                filePath = fileElement.dataset.path;
            }

            const file = filePath ? app.vault.getFileByPath(filePath) : null;
            if (!(file instanceof TFile) || file.extension !== 'md') {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const menu = new Menu();
            addManualSortGroupHeaderMenuItems({ menu, app, file, propertyKey: manualSortGroupHeaderPropertyKey, metadataService });
            menu.showAtMouseEvent(event.nativeEvent);
        },
        [app, manualSortGroupHeaderPropertyKey, metadataService]
    );

    return (
        <div
            ref={scrollContainerRef}
            className="nn-list-pane-scroller nn-manual-sort-scroller"
            role="list"
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onContextMenu={handleContextMenu}
        >
            <div className="nn-manual-sort-panel">
                <div className="nn-manual-sort-header">
                    <div className="nn-manual-sort-header-text">
                        <span className="nn-manual-sort-title">{strings.listPane.manualSortTitle.replace('{property}', propertyKey)}</span>
                        <span className="nn-manual-sort-hint">{strings.listPane.manualSortHint.replace('{property}', propertyKey)}</span>
                        {nonMarkdownCount > 0 ? (
                            <span className="nn-manual-sort-hint">{strings.listPane.manualSortNonMarkdownHint}</span>
                        ) : null}
                    </div>
                    <button type="button" className="nn-support-button nn-manual-sort-done" onClick={onDone} disabled={isDoneDisabled}>
                        {strings.listPane.manualSortDone}
                    </button>
                </div>

                {hasNoFiles ? (
                    <div className="nn-empty-state">
                        <div className="nn-empty-message">{strings.listPane.emptyStateNoNotes}</div>
                    </div>
                ) : (
                    <DndContext
                        sensors={sensors}
                        collisionDetection={typeFilteredCollisionDetection}
                        modifiers={[verticalAxisOnly]}
                        onDragStart={handleDragStart}
                        onDragCancel={handleDragCancel}
                        onDragEnd={handleDragEnd}
                    >
                        <div aria-busy={isSaving ? 'true' : undefined}>
                            {entries.length > 0 ? (
                                <ManualSortGroup
                                    rankedRows={rankedRows}
                                    unsortedRows={unsortedRows}
                                    nonMarkdownRows={nonMarkdownRows}
                                    canReorder={!isSaving}
                                    rowContext={rowContext}
                                    noteShortcutKeysByPath={noteShortcutKeysByPath}
                                    selectedFiles={selectedFiles}
                                    activeDragPaths={activeDragPaths}
                                    activeDragPath={activeDragPath}
                                    scrollContainerRef={scrollContainerRef}
                                    scrollToFilePathRef={scrollToFilePathRef}
                                    resolveDropPathAtClientYRef={resolveDropPathAtClientYRef}
                                />
                            ) : null}
                        </div>
                        <DragOverlay dropAnimation={null}>
                            {activeDragEntry ? (
                                <div className="nn-manual-sort-row nn-manual-sort-row-drag-overlay">
                                    <div className="nn-manual-sort-file">{activeDragEntry.file.basename || activeDragEntry.file.name}</div>
                                </div>
                            ) : null}
                        </DragOverlay>
                    </DndContext>
                )}
            </div>
        </div>
    );
}
