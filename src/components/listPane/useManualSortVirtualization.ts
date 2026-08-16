/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { useCallback, type RefObject } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range, type Virtualizer } from '@tanstack/react-virtual';
import { OVERSCAN } from '../../types';

export interface ManualSortFlattenSourceRow<TEntry, THeader> {
    key: string;
    filePath: string;
    entry: TEntry;
    sortable: boolean;
    header?: THeader;
}

export type ManualSortFlatRow<TEntry, THeader> =
    | {
          kind: 'section-header';
          key: 'section:unsorted';
          section: 'unsorted';
          suppressTopSpacing: boolean;
      }
    | {
          kind: 'file';
          key: string;
          filePath: string;
          entry: TEntry;
          source: ManualSortFlattenSourceRow<TEntry, THeader>;
      };

export interface ManualSortFlatModel<TEntry, THeader> {
    rows: ManualSortFlatRow<TEntry, THeader>[];
    fileIndexByPath: Map<string, number>;
    sortableIds: string[];
}

export function buildManualSortFlatRows<TEntry, THeader>({
    rankedRows,
    unsortedRows,
    nonMarkdownRows
}: {
    rankedRows: readonly ManualSortFlattenSourceRow<TEntry, THeader>[];
    unsortedRows: readonly ManualSortFlattenSourceRow<TEntry, THeader>[];
    nonMarkdownRows: readonly ManualSortFlattenSourceRow<TEntry, THeader>[];
}): ManualSortFlatModel<TEntry, THeader> {
    const rows: ManualSortFlatRow<TEntry, THeader>[] = [];
    const fileIndexByPath = new Map<string, number>();
    const sortableIds: string[] = [];

    const appendFileRows = (sourceRows: readonly ManualSortFlattenSourceRow<TEntry, THeader>[]): void => {
        for (const source of sourceRows) {
            fileIndexByPath.set(source.filePath, rows.length);
            rows.push({
                kind: 'file',
                key: `file:${source.key}`,
                filePath: source.filePath,
                entry: source.entry,
                source
            });
            if (source.sortable) {
                sortableIds.push(source.filePath);
            }
        }
    };

    appendFileRows(rankedRows);
    if (unsortedRows.length > 0) {
        rows.push({
            kind: 'section-header',
            key: 'section:unsorted',
            section: 'unsorted',
            suppressTopSpacing: rankedRows.length === 0
        });
        appendFileRows(unsortedRows);
    }
    appendFileRows(nonMarkdownRows);

    return { rows, fileIndexByPath, sortableIds };
}

export function resolveManualSortAdjacentEntry<T>(
    sources: readonly { section: string; entry: T }[],
    sourceIndex: number,
    offset: -1 | 1
): T | undefined {
    const source = sources[sourceIndex];
    const adjacent = sources[sourceIndex + offset];
    return source && adjacent?.section === source.section ? adjacent.entry : undefined;
}

export function includePinnedManualSortIndex(indexes: readonly number[], pinnedIndex: number | undefined): number[] {
    if (pinnedIndex === undefined || pinnedIndex < 0 || indexes.includes(pinnedIndex)) {
        return [...indexes];
    }
    return [...indexes, pinnedIndex].sort((left, right) => left - right);
}

export function clampManualSortScrollMargin(scrollMargin: number): number {
    return Math.max(0, scrollMargin);
}

export function resolveManualSortOffsetFromClientY(clientY: number, listTop: number, scrollMargin: number): number {
    return clientY - listTop + scrollMargin;
}

export function resolveManualSortFilePathAtOffset<TEntry, THeader>(
    rows: readonly ManualSortFlatRow<TEntry, THeader>[],
    measurements: readonly { index: number; start: number; end: number }[],
    offset: number,
    resolveMeasurementAtOffset?: (offset: number) => { index: number; start: number; end: number } | undefined
): string | null {
    let low = 0;
    let high = measurements.length - 1;
    let measurementIndex = -1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const measurement = measurements[middle];
        if (!measurement) {
            break;
        }
        if (offset < measurement.start) {
            high = middle - 1;
        } else if (offset >= measurement.end) {
            low = middle + 1;
        } else {
            measurementIndex = measurement.index;
            break;
        }
    }
    if (measurementIndex < 0) {
        measurementIndex = resolveMeasurementAtOffset?.(offset)?.index ?? -1;
        if (measurementIndex < 0) {
            return null;
        }
    }
    const row = rows[measurementIndex];
    if (row?.kind === 'file') {
        return row.source.sortable ? row.filePath : null;
    }
    for (let index = measurementIndex + 1; index < rows.length; index += 1) {
        const candidate = rows[index];
        if (candidate?.kind === 'file') {
            return candidate.source.sortable ? candidate.filePath : null;
        }
    }
    return null;
}

export function useManualSortVirtualization<TEntry, THeader>({
    rows,
    scrollContainerRef,
    scrollMargin,
    pinnedIndex
}: {
    rows: readonly ManualSortFlatRow<TEntry, THeader>[];
    scrollContainerRef: RefObject<HTMLDivElement>;
    scrollMargin: number;
    pinnedIndex?: number;
}): Virtualizer<HTMLDivElement, Element> {
    const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows]);
    const rangeExtractor = useCallback(
        (range: Range) => includePinnedManualSortIndex(defaultRangeExtractor(range), pinnedIndex),
        [pinnedIndex]
    );
    const effectiveScrollMargin = clampManualSortScrollMargin(scrollMargin);
    return useVirtualizer({
        count: rows.length,
        getItemKey,
        getScrollElement: () => scrollContainerRef.current,
        estimateSize: index => {
            const row = rows[index];
            if (row?.kind === 'section-header') {
                return 40;
            }
            return row?.source.header === undefined ? 72 : 136;
        },
        overscan: OVERSCAN,
        rangeExtractor,
        scrollMargin: effectiveScrollMargin,
        scrollPaddingStart: effectiveScrollMargin,
        useScrollendEvent: true
    });
}
