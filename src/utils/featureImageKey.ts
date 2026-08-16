/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import type { TFile } from 'obsidian';
import type { FeatureImagePixelSizeSetting } from '../settings/types';

/** Durable key for a bounded local thumbnail. */
export function getLocalFeatureImageKey(file: TFile, pixelSize: FeatureImagePixelSizeSetting = '256'): string {
    return `f:${file.path}@${file.stat.mtime}:${pixelSize}`;
}
