/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { describe, expect, it } from 'vitest';
import {
    buildManualSortFlatRows,
    clampManualSortScrollMargin,
    includePinnedManualSortIndex,
    resolveManualSortAdjacentEntry,
    resolveManualSortOffsetFromClientY,
    resolveManualSortFilePathAtOffset,
    type ManualSortFlattenSourceRow
} from '../../src/components/listPane/useManualSortVirtualization';

type TestEntry = { path: string };
type TestHeader = { label: string };

function row(path: string, header?: TestHeader): ManualSortFlattenSourceRow<TestEntry, TestHeader> {
    return {
        key: path,
        filePath: path,
        entry: { path },
        sortable: path.endsWith('.md'),
        header
    };
}

describe('manual sort virtualization model', () => {
    it('keeps custom headers inside file rows so virtual and sortable rects match', () => {
        const model = buildManualSortFlatRows({
            rankedRows: [row('ranked/a.md', { label: 'Chapter A' }), row('ranked/b.md')],
            unsortedRows: [row('unsorted/c.md')],
            nonMarkdownRows: [row('assets/image.png')]
        });

        expect(model.rows.map(item => [item.kind, item.key])).toEqual([
            ['file', 'file:ranked/a.md'],
            ['file', 'file:ranked/b.md'],
            ['section-header', 'section:unsorted'],
            ['file', 'file:unsorted/c.md'],
            ['file', 'file:assets/image.png']
        ]);
        expect(model.rows[0]).toMatchObject({ kind: 'file', source: { header: { label: 'Chapter A' } } });
        expect(model.fileIndexByPath.get('ranked/a.md')).toBe(0);
        expect(model.fileIndexByPath.get('unsorted/c.md')).toBe(3);
        expect(model.fileIndexByPath.get('assets/image.png')).toBe(4);
        expect(model.sortableIds).toEqual(['ranked/a.md', 'ranked/b.md', 'unsorted/c.md']);

        const unsortedOnly = buildManualSortFlatRows({
            rankedRows: [],
            unsortedRows: [row('unsorted/only.md')],
            nonMarkdownRows: []
        });
        expect(unsortedOnly.rows[0]).toMatchObject({ kind: 'section-header', suppressTopSpacing: true });
    });

    it('resolves an offscreen destination from virtual offsets and skips non-file rows', () => {
        const model = buildManualSortFlatRows({
            rankedRows: [row('ranked/a.md')],
            unsortedRows: [row('unsorted/b.md')],
            nonMarkdownRows: [row('assets/image.png')]
        });
        const measurements = model.rows.map((_, index) => ({ index, start: index * 44, end: (index + 1) * 44 }));

        expect(resolveManualSortFilePathAtOffset(model.rows, measurements, 44 * 2 + 5)).toBe('unsorted/b.md');
        // The unsorted section header resolves forward to its first sortable file.
        expect(resolveManualSortFilePathAtOffset(model.rows, measurements, 44 + 5)).toBe('unsorted/b.md');
        expect(resolveManualSortFilePathAtOffset(model.rows, measurements, 44 * 3 + 5)).toBeNull();
    });

    it('uses the full virtual model when the drop offset is outside rendered measurements', () => {
        const model = buildManualSortFlatRows({
            rankedRows: [row('ranked/a.md'), row('ranked/b.md'), row('ranked/c.md')],
            unsortedRows: [],
            nonMarkdownRows: []
        });
        const renderedMeasurements = [{ index: 0, start: 0, end: 72 }];

        expect(resolveManualSortFilePathAtOffset(model.rows, renderedMeasurements, 160, () => ({ index: 2, start: 144, end: 216 }))).toBe(
            'ranked/c.md'
        );
    });

    it('does not resolve row neighbours across manual-sort section boundaries', () => {
        const sources = [
            { section: 'ranked', entry: 'ranked-last' },
            { section: 'unsorted', entry: 'unsorted-first' },
            { section: 'unsorted', entry: 'unsorted-second' }
        ];

        expect(resolveManualSortAdjacentEntry(sources, 0, 1)).toBeUndefined();
        expect(resolveManualSortAdjacentEntry(sources, 1, -1)).toBeUndefined();
        expect(resolveManualSortAdjacentEntry(sources, 1, 1)).toBe('unsorted-second');
    });

    it('keeps the active drag index mounted outside the viewport range', () => {
        expect(includePinnedManualSortIndex([100, 101, 102], 5)).toEqual([5, 100, 101, 102]);
        expect(includePinnedManualSortIndex([100, 101, 102], 101)).toEqual([100, 101, 102]);
        expect(includePinnedManualSortIndex([100, 101, 102], undefined)).toEqual([100, 101, 102]);
    });

    it('clamps transient negative scroll margins at the shared measurement boundary', () => {
        expect(clampManualSortScrollMargin(-12)).toBe(0);
        expect(clampManualSortScrollMargin(48)).toBe(48);
    });

    it('maps drag coordinates through the live list rect into virtualizer space', () => {
        expect(resolveManualSortOffsetFromClientY(420, 300, 80)).toBe(200);
    });
});
