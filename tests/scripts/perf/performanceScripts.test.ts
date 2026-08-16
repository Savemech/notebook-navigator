/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporaryPaths: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryPaths.map(entry => rm(entry, { recursive: true, force: true })));
    temporaryPaths.length = 0;
});

describe('performance scripts', () => {
    it('emits a deterministic structural model for the scale fixture', async () => {
        const script = path.join(repoRoot, 'scripts/perf/run-performance-model.mjs');
        const first = await execFileAsync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
        const second = await execFileAsync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });

        expect(first.stdout).toBe(second.stdout);
        const model = JSON.parse(first.stdout) as {
            baseline: { manualSortMountedRows: number };
            target: { manualSortMountedRows: number; desktopDecodedPixelBudget: number };
            reductionFactors: { mountedRows: number };
        };
        expect(model.baseline.manualSortMountedRows).toBe(22_844);
        expect(model.target.manualSortMountedRows).toBe(250);
        expect(model.target.desktopDecodedPixelBudget).toBe(100_000_000);
        expect(model.reductionFactors.mountedRows).toBeGreaterThan(90);
    });

    it('generates a fixed-seed vault and refuses to overwrite it', async () => {
        const parent = await mkdtemp(path.join(os.tmpdir(), 'nn-performance-fixture-'));
        temporaryPaths.push(parent);
        const output = path.join(parent, 'vault');
        const script = path.join(repoRoot, 'scripts/perf/generate-performance-vault.mjs');
        const args = [script, '--output', output, '--markdown', '3', '--images', '2', '--folders', '2', '--seed', '7'];

        await execFileAsync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' });
        const manifest = JSON.parse(await readFile(path.join(output, 'performance-fixture.json'), 'utf8')) as {
            seed: number;
            markdownCount: number;
            imageCount: number;
            indexableFiles: number;
        };
        expect(manifest).toMatchObject({ seed: 7, markdownCount: 3, imageCount: 2, indexableFiles: 5 });

        await expect(execFileAsync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' })).rejects.toMatchObject({ code: 1 });
    });
});
