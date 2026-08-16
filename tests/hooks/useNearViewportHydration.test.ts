/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { describe, expect, it, vi } from 'vitest';
import {
    resolveViewportHydrationRoot,
    resolveViewportHydrationLevel,
    SharedViewportHydrationObserver,
    type ViewportHydrationObserverLike
} from '../../src/hooks/useNearViewportHydration';

describe('SharedViewportHydrationObserver', () => {
    it('resolves shell, overscan metadata, visible, and forced hydration levels', () => {
        expect(resolveViewportHydrationLevel(false, false, false, false)).toBe('shell');
        expect(resolveViewportHydrationLevel(false, false, true, false)).toBe('metadata');
        expect(resolveViewportHydrationLevel(false, false, true, true)).toBe('visible');
        expect(resolveViewportHydrationLevel(true, false, false, false)).toBe('visible');
        expect(resolveViewportHydrationLevel(false, true, false, false)).toBe('visible');
        expect(resolveViewportHydrationLevel(false, false, false, false, true)).toBe('metadata');
    });

    it('uses the nearest list scroller as the intersection root', () => {
        const scroller = {} as Element;
        const closest = vi.fn().mockReturnValue(scroller);
        const element = {
            closest
        } as unknown as Element;

        expect(resolveViewportHydrationRoot(element)).toBe(scroller);
        expect(closest).toHaveBeenCalledWith('.nn-list-pane-scroller');
    });

    it('shares one observer and stops notifying an element after cleanup', () => {
        let emit: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | null = null;
        const observe = vi.fn();
        const unobserve = vi.fn();
        const disconnect = vi.fn();
        const registry = new SharedViewportHydrationObserver(callback => {
            emit = callback;
            return { observe, unobserve, disconnect } satisfies ViewportHydrationObserverLike;
        });
        const element = {} as Element;
        const onVisibilityChange = vi.fn();

        const cleanup = registry.observe(element, onVisibilityChange);
        expect(observe).toHaveBeenCalledWith(element);

        emit?.([{ target: element, isIntersecting: true }]);
        expect(onVisibilityChange).toHaveBeenLastCalledWith(true);

        cleanup();
        expect(unobserve).toHaveBeenCalledWith(element);
        emit?.([{ target: element, isIntersecting: false }]);
        expect(onVisibilityChange).toHaveBeenCalledTimes(1);

        registry.disconnect();
        expect(disconnect).toHaveBeenCalledTimes(1);
    });
});
