#!/usr/bin/env node

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

function readInteger(value, name, fallback) {
    if (value === undefined) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
    return parsed;
}

function nextRandom(state) {
    let value = state.value >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    state.value = value >>> 0;
    return state.value / 0x1_0000_0000;
}

function paddedMarkdown(index, folder, targetBytes, random) {
    const createdDay = 1 + Math.floor(nextRandom(random) * 28);
    const header = `---\ntitle: Performance note ${index}\ncreated: 2026-01-${String(createdDay).padStart(2, '0')}\ntags: [performance, group-${index % 32}]\n---\n\n# Performance note ${index}\n\nFolder ${folder}. [[note-${Math.max(0, index - 1)}]]\n`;
    if (Buffer.byteLength(header) >= targetBytes) {
        return header;
    }
    return `${header}\n${'x'.repeat(targetBytes - Buffer.byteLength(header) - 1)}\n`;
}

const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);

async function ensureMissing(output) {
    try {
        await access(output);
        throw new Error(`Output already exists: ${output}`);
    } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') {
            return;
        }
        throw error;
    }
}

async function main() {
    const { values } = parseArgs({
        options: {
            output: { type: 'string' },
            seed: { type: 'string', default: '1337' },
            markdown: { type: 'string', default: '22844' },
            images: { type: 'string', default: '1132' },
            folders: { type: 'string', default: '128' },
            'markdown-bytes': { type: 'string', default: '2048' },
            'image-bytes': { type: 'string', default: '4096' }
        }
    });
    if (!values.output) {
        throw new Error('--output is required');
    }

    const output = path.resolve(values.output);
    const seed = readInteger(values.seed, 'seed', 1337);
    const markdownCount = readInteger(values.markdown, 'markdown', 22_844);
    const imageCount = readInteger(values.images, 'images', 1_132);
    const folderCount = Math.max(1, readInteger(values.folders, 'folders', 128));
    const markdownBytes = readInteger(values['markdown-bytes'], 'markdown-bytes', 2_048);
    const imageBytes = Math.max(ONE_PIXEL_PNG.byteLength, readInteger(values['image-bytes'], 'image-bytes', 4_096));

    await ensureMissing(output);
    await mkdir(output, { recursive: true });
    const random = { value: seed || 1 };

    for (let index = 0; index < markdownCount; index += 1) {
        const folder = `folder-${String(index % folderCount).padStart(3, '0')}`;
        const folderPath = path.join(output, folder);
        await mkdir(folderPath, { recursive: true });
        await writeFile(path.join(folderPath, `note-${String(index).padStart(5, '0')}.md`), paddedMarkdown(index, folder, markdownBytes, random));
    }

    const imagePadding = Buffer.alloc(imageBytes - ONE_PIXEL_PNG.byteLength, 0);
    for (let index = 0; index < imageCount; index += 1) {
        const folder = `folder-${String(index % folderCount).padStart(3, '0')}`;
        const folderPath = path.join(output, folder);
        await mkdir(folderPath, { recursive: true });
        await writeFile(path.join(folderPath, `image-${String(index).padStart(5, '0')}.png`), Buffer.concat([ONE_PIXEL_PNG, imagePadding]));
    }

    const manifest = {
        schemaVersion: 1,
        seed,
        markdownCount,
        imageCount,
        indexableFiles: markdownCount + imageCount,
        folderCount,
        markdownBytes,
        imageBytes
    };
    await writeFile(path.join(output, 'performance-fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ output, ...manifest })}\n`);
}

try {
    await main();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
