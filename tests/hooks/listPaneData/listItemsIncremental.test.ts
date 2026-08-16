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
import { TFile } from 'obsidian';
import { updateFileIndexSnapshot } from '../../../src/hooks/listPaneData/listItems';

function createFiles(count: number): TFile[] {
    return Array.from({ length: count }, (_, index) => new TFile(`notes/${index.toString().padStart(5, '0')}.md`));
}

describe('incremental list index snapshots', () => {
    it('preserves map and snapshot identity when only file object identity changes', () => {
        const files = createFiles(23_976);
        const initial = updateFileIndexSnapshot(undefined, files);
        const equivalentFiles = files.map(file => new TFile(file.path));

        const next = updateFileIndexSnapshot(initial, equivalentFiles);

        expect(next).toBe(initial);
        expect(next.map).toBe(initial.map);
        expect(next.map.size).toBe(23_976);
    });

    it('replaces only the structural snapshot contract for a rename', () => {
        const files = createFiles(1_000);
        const initial = updateFileIndexSnapshot(undefined, files);
        const renamedFiles = files.slice();
        renamedFiles[500] = new TFile('notes/renamed.md');

        const next = updateFileIndexSnapshot(initial, renamedFiles);

        expect(next).not.toBe(initial);
        expect(next.map).not.toBe(initial.map);
        expect(next.map.has(files[500].path)).toBe(false);
        expect(next.map.get('notes/renamed.md')).toBe(500);
        expect(next.map.get(files[999].path)).toBe(999);
    });
});
