/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, TFile } from 'obsidian';
import { LIMITS } from '../../src/constants/limits';

const { loadPdfJsMock } = vi.hoisted(() => ({
    loadPdfJsMock: vi.fn()
}));

vi.mock('obsidian', async () => {
    const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
    return {
        ...actual,
        loadPdfJs: loadPdfJsMock
    };
});

import { renderPdfCoverThumbnail } from '../../src/services/content/pdf/pdfCoverThumbnail';

beforeEach(() => {
    loadPdfJsMock.mockReset();
});

describe('renderPdfCoverThumbnail resource limits', () => {
    it('rejects an oversized PDF before loading pdf.js', async () => {
        const app = new App();
        const file = new TFile();
        file.path = 'oversized.pdf';
        file.name = 'oversized.pdf';
        file.basename = 'oversized';
        file.extension = 'pdf';
        file.stat.size = LIMITS.thumbnails.pdf.maxSourceBytes.desktop + 1;

        const result = await renderPdfCoverThumbnail(app, file, {
            maxWidth: 256,
            maxHeight: 144,
            mimeType: 'image/webp'
        });

        expect(result).toBeNull();
        expect(loadPdfJsMock).not.toHaveBeenCalled();
    });
});
