/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

export interface ViewportHydrationEntry {
    target: Element;
    isIntersecting: boolean;
}

export interface ViewportHydrationObserverLike {
    observe(element: Element): void;
    unobserve(element: Element): void;
    disconnect(): void;
}

type ViewportHydrationObserverFactory = (callback: (entries: ViewportHydrationEntry[]) => void) => ViewportHydrationObserverLike;

export class SharedViewportHydrationObserver {
    private readonly callbacks = new Map<Element, (isNearViewport: boolean) => void>();
    private readonly observer: ViewportHydrationObserverLike;

    constructor(createObserver: ViewportHydrationObserverFactory) {
        this.observer = createObserver(entries => {
            for (const entry of entries) {
                this.callbacks.get(entry.target)?.(entry.isIntersecting);
            }
        });
    }

    observe(element: Element, callback: (isNearViewport: boolean) => void): () => void {
        this.callbacks.set(element, callback);
        this.observer.observe(element);
        return () => {
            if (this.callbacks.get(element) !== callback) {
                return;
            }
            this.callbacks.delete(element);
            this.observer.unobserve(element);
        };
    }

    disconnect(): void {
        this.callbacks.clear();
        this.observer.disconnect();
    }
}

export type ViewportHydrationLevel = 'shell' | 'metadata' | 'visible';

export function resolveViewportHydrationLevel(
    forceHydration: boolean,
    observerUnavailable: boolean,
    isNearViewport: boolean,
    isVisible: boolean,
    hasReachedVisible = false
): ViewportHydrationLevel {
    if (forceHydration || observerUnavailable || isVisible) {
        return 'visible';
    }
    return isNearViewport || hasReachedVisible ? 'metadata' : 'shell';
}

export function resolveViewportHydrationRoot(element: Element): Element | null {
    return element.closest('.nn-list-pane-scroller');
}

const nearObserversByRoot = new WeakMap<object, SharedViewportHydrationObserver>();
const visibleObserversByRoot = new WeakMap<object, SharedViewportHydrationObserver>();

function getSharedObserver(
    observersByRoot: WeakMap<object, SharedViewportHydrationObserver>,
    observerKey: object,
    targetWindow: Window,
    root: Element | null,
    rootMargin: string
): SharedViewportHydrationObserver | null {
    const ObserverConstructor = (targetWindow as Window & { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver;
    if (typeof ObserverConstructor !== 'function') {
        return null;
    }
    const existing = observersByRoot.get(observerKey);
    if (existing) {
        return existing;
    }
    const observer = new SharedViewportHydrationObserver(callback => {
        return new ObserverConstructor(entries => callback(entries), {
            root,
            rootMargin,
            threshold: 0
        });
    });
    observersByRoot.set(observerKey, observer);
    return observer;
}

export function useNearViewportHydration(forceHydration = false): {
    hydrationRef: RefObject<HTMLDivElement>;
    hydrationLevel: ViewportHydrationLevel;
} {
    const hydrationRef = useRef<HTMLDivElement | null>(null);
    const [isNearViewport, setIsNearViewport] = useState(false);
    const [isVisible, setIsVisible] = useState(false);
    const [observerUnavailable, setObserverUnavailable] = useState(false);
    const hasReachedVisibleRef = useRef(forceHydration);
    if (forceHydration) {
        hasReachedVisibleRef.current = true;
    }

    useEffect(() => {
        if (forceHydration) {
            return;
        }
        const element = hydrationRef.current;
        const targetWindow = element?.ownerDocument.defaultView;
        if (!element || !targetWindow) {
            setObserverUnavailable(true);
            return;
        }
        const root = resolveViewportHydrationRoot(element);
        const observerKey = root ?? targetWindow;
        const nearObserver = getSharedObserver(nearObserversByRoot, observerKey, targetWindow, root, '600px 0px');
        const visibleObserver = getSharedObserver(visibleObserversByRoot, observerKey, targetWindow, root, '0px');
        if (!nearObserver || !visibleObserver) {
            setObserverUnavailable(true);
            return;
        }
        const stopNearObservation = nearObserver.observe(element, setIsNearViewport);
        const stopVisibleObservation = visibleObserver.observe(element, visible => {
            if (visible) {
                hasReachedVisibleRef.current = true;
            }
            setIsVisible(visible);
        });
        return () => {
            stopNearObservation();
            stopVisibleObservation();
        };
    }, [forceHydration]);

    return {
        hydrationRef,
        hydrationLevel: resolveViewportHydrationLevel(
            forceHydration,
            observerUnavailable,
            isNearViewport,
            isVisible,
            hasReachedVisibleRef.current
        )
    };
}
