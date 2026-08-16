#!/usr/bin/env node

import { parseArgs } from 'node:util';

const DEFAULTS = Object.freeze({
    indexableFiles: 23_976,
    markdownFiles: 22_844,
    imageCandidates: 1_132,
    mountedRowBudget: 250,
    visibleImageBudget: 64,
    decodedPixelBudget: 100_000_000,
    thumbnailWidth: 256,
    thumbnailHeight: 144
});

function readPositiveInteger(value, name, fallback) {
    if (value === undefined) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
    return parsed;
}

export function buildPerformanceModel(overrides = {}) {
    const fixture = {
        indexableFiles: readPositiveInteger(overrides.indexableFiles, 'indexableFiles', DEFAULTS.indexableFiles),
        markdownFiles: readPositiveInteger(overrides.markdownFiles, 'markdownFiles', DEFAULTS.markdownFiles),
        imageCandidates: readPositiveInteger(overrides.imageCandidates, 'imageCandidates', DEFAULTS.imageCandidates)
    };
    const budgets = {
        mountedRows: readPositiveInteger(overrides.mountedRowBudget, 'mountedRowBudget', DEFAULTS.mountedRowBudget),
        visibleImages: readPositiveInteger(overrides.visibleImageBudget, 'visibleImageBudget', DEFAULTS.visibleImageBudget),
        decodedPixels: readPositiveInteger(overrides.decodedPixelBudget, 'decodedPixelBudget', DEFAULTS.decodedPixelBudget),
        thumbnailWidth: DEFAULTS.thumbnailWidth,
        thumbnailHeight: DEFAULTS.thumbnailHeight
    };

    const baseline = {
        manualSortMountedRows: fixture.markdownFiles,
        eagerImageCandidates: fixture.imageCandidates,
        desktopDecodedPixelBudget: Number.MAX_SAFE_INTEGER
    };
    const target = {
        manualSortMountedRows: Math.min(fixture.markdownFiles, budgets.mountedRows),
        eagerImageCandidates: Math.min(fixture.imageCandidates, budgets.visibleImages),
        desktopDecodedPixelBudget: budgets.decodedPixels
    };
    const ratio = (before, after) => (after === 0 ? null : Number((before / after).toFixed(3)));
    const thumbnailRgbaBytes = budgets.thumbnailWidth * budgets.thumbnailHeight * 4;

    return {
        schemaVersion: 1,
        kind: 'structural-performance-model',
        deterministic: true,
        fixture,
        budgets,
        baseline,
        target,
        reductionFactors: {
            mountedRows: ratio(baseline.manualSortMountedRows, target.manualSortMountedRows),
            eagerImageCandidates: ratio(baseline.eagerImageCandidates, target.eagerImageCandidates),
            decodedPixelBudget: ratio(baseline.desktopDecodedPixelBudget, target.desktopDecodedPixelBudget)
        },
        memoryCeilings: {
            decodedRgbaBytes: budgets.decodedPixels * 4,
            visibleThumbnailRgbaBytes: target.eagerImageCandidates * thumbnailRgbaBytes
        },
        caveat: 'Structural work model only; Electron renderer/private/GPU memory and wall time require the documented in-Obsidian capture.'
    };
}

function main() {
    const { values } = parseArgs({
        options: {
            'indexable-files': { type: 'string' },
            'markdown-files': { type: 'string' },
            'image-candidates': { type: 'string' },
            'mounted-row-budget': { type: 'string' },
            'visible-image-budget': { type: 'string' },
            'decoded-pixel-budget': { type: 'string' }
        }
    });
    const model = buildPerformanceModel({
        indexableFiles: values['indexable-files'],
        markdownFiles: values['markdown-files'],
        imageCandidates: values['image-candidates'],
        mountedRowBudget: values['mounted-row-budget'],
        visibleImageBudget: values['visible-image-budget'],
        decodedPixelBudget: values['decoded-pixel-budget']
    });
    process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
