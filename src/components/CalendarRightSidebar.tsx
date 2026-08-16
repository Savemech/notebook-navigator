import { useCallback, useEffect, useRef, useState } from 'react';
import { TFile } from 'obsidian';
import { useServices } from '../context/ServicesContext';
import { useSettingsState } from '../context/SettingsContext';
import { isStorageRuntimeActive, subscribeStorageRuntimeActive } from '../context/StorageContext';
import { runAsyncAction } from '../utils/async';
import { getDBInstance } from '../storage/fileOperations';
import type { ContentProviderRuntimeSession } from '../services/content/ContentProviderRuntime';
import { getMarkdownPipelineClearFlags } from '../services/content/MarkdownPipelineContentProvider';
import { NotebookNavigatorView } from '../view/NotebookNavigatorView';
import { Calendar } from './calendar';
import type { CalendarFeatureImageTarget } from './calendar/useCalendarFeatureImages';

export function CalendarRightSidebar() {
    const { app, plugin } = useServices();
    const settings = useSettingsState();
    const isMountedRef = useRef(true);
    const latestSettingsRef = useRef(settings);
    latestSettingsRef.current = settings;
    const previousSettingsRef = useRef(settings);
    const calendarContentRuntimeSessionRef = useRef<ContentProviderRuntimeSession | null>(null);
    const visibleCalendarNoteFilesRef = useRef<TFile[]>([]);
    const visibleCalendarNotePathsRef = useRef<Set<string>>(new Set());
    const [storageRuntimeActive, setStorageRuntimeActive] = useState(() => isStorageRuntimeActive());

    const getCalendarContentRegistry = useCallback(() => {
        if (!calendarContentRuntimeSessionRef.current) {
            calendarContentRuntimeSessionRef.current = plugin.acquireContentProviderRuntime();
        }

        return calendarContentRuntimeSessionRef.current.registry;
    }, [plugin]);

    const queueCalendarContentRefresh = useCallback(
        (files: TFile[]) => {
            if (storageRuntimeActive || isStorageRuntimeActive() || files.length === 0) {
                return;
            }

            const markdownFiles = files.filter(file => file.extension === 'md');
            if (markdownFiles.length === 0) {
                return;
            }

            getCalendarContentRegistry().queueFilesForAllProviders(markdownFiles, latestSettingsRef.current, {
                include: ['markdownPipeline']
            });
        },
        [getCalendarContentRegistry, storageRuntimeActive]
    );

    useEffect(() => {
        isMountedRef.current = true;

        return () => {
            isMountedRef.current = false;
            calendarContentRuntimeSessionRef.current?.release();
            calendarContentRuntimeSessionRef.current = null;
        };
    }, []);

    useEffect(() => subscribeStorageRuntimeActive(setStorageRuntimeActive), []);

    useEffect(() => {
        if (storageRuntimeActive) {
            calendarContentRuntimeSessionRef.current?.release();
            calendarContentRuntimeSessionRef.current = null;
            return;
        }

        queueCalendarContentRefresh(visibleCalendarNoteFilesRef.current);
    }, [queueCalendarContentRefresh, storageRuntimeActive]);

    useEffect(() => {
        const modifyRef = app.vault.on('modify', file => {
            if (storageRuntimeActive || !(file instanceof TFile) || file.extension !== 'md') {
                return;
            }

            if (!visibleCalendarNotePathsRef.current.has(file.path)) {
                return;
            }

            queueCalendarContentRefresh([file]);
        });

        return () => {
            app.vault.offref(modifyRef);
        };
    }, [app.vault, queueCalendarContentRefresh, storageRuntimeActive]);

    useEffect(() => {
        const oldSettings = previousSettingsRef.current;
        previousSettingsRef.current = settings;

        if (oldSettings === settings || storageRuntimeActive || isStorageRuntimeActive()) {
            return;
        }

        const { shouldClearFeatureImage, shouldClearPreview } = getMarkdownPipelineClearFlags({
            oldSettings,
            newSettings: settings
        });
        const enabledFeatureImages = oldSettings.showFeatureImage !== settings.showFeatureImage && settings.showFeatureImage;
        if (!shouldClearFeatureImage && !shouldClearPreview && !enabledFeatureImages) {
            return;
        }

        const filesByPath = new Map<string, TFile>();
        visibleCalendarNoteFilesRef.current.forEach(file => {
            if (file.extension === 'md') {
                filesByPath.set(file.path, file);
            }
        });
        const files = Array.from(filesByPath.values());
        if (files.length === 0) {
            return;
        }

        const registry = calendarContentRuntimeSessionRef.current?.registry;
        registry?.stopAllProcessing();
        runAsyncAction(async () => {
            await registry?.getProvider('markdownPipeline')?.waitForIdle();
            if (!isMountedRef.current || isStorageRuntimeActive()) {
                return;
            }

            const db = getDBInstance();
            const paths = files.map(file => file.path);
            if (shouldClearPreview) {
                await db.batchClearFileContent(paths, 'preview');
            }
            if (shouldClearFeatureImage) {
                await db.batchClearFileContent(paths, 'featureImage');
            }

            if (!isMountedRef.current || isStorageRuntimeActive()) {
                return;
            }

            queueCalendarContentRefresh(files);
        });
    }, [queueCalendarContentRefresh, settings, storageRuntimeActive]);

    const handleAddDateFilter = useCallback(
        (dateToken: string) => {
            runAsyncAction(async () => {
                let leaves = plugin.getNavigatorLeaves();
                let shouldRevealLeaf = true;
                if (leaves.length === 0) {
                    await plugin.activateView();
                    leaves = plugin.getNavigatorLeaves();
                    shouldRevealLeaf = false;
                }

                const navigatorLeaf = leaves[0];
                if (!navigatorLeaf) {
                    return;
                }

                const navigatorView = navigatorLeaf.view;
                if (!(navigatorView instanceof NotebookNavigatorView)) {
                    return;
                }

                navigatorView.addDateFilterToSearch(dateToken);
                if (shouldRevealLeaf) {
                    await app.workspace.revealLeaf(navigatorLeaf);
                }
            });
        },
        [app.workspace, plugin]
    );
    const handleVisibleCalendarNoteFilesChange = useCallback(
        (files: TFile[]) => {
            visibleCalendarNoteFilesRef.current = files;
            visibleCalendarNotePathsRef.current = new Set(files.map(file => file.path));
            queueCalendarContentRefresh(files);
        },
        [queueCalendarContentRefresh]
    );
    const handleMissingFeatureImage = useCallback(
        (target: CalendarFeatureImageTarget) => {
            runAsyncAction(async () => {
                if (storageRuntimeActive || !settings.showFeatureImage || target.file.extension !== 'md') {
                    return;
                }

                const db = getDBInstance();
                await db.clearFileContent(target.file.path, 'featureImage');
                if (!isMountedRef.current || isStorageRuntimeActive()) {
                    return;
                }

                queueCalendarContentRefresh([target.file]);
            });
        },
        [queueCalendarContentRefresh, settings.showFeatureImage, storageRuntimeActive]
    );

    return (
        <div className="nn-calendar-right-sidebar nn-list-pane">
            <div className="nn-calendar-right-sidebar-content">
                <Calendar
                    weeksToShowOverride={6}
                    onAddDateFilter={handleAddDateFilter}
                    onMissingFeatureImage={handleMissingFeatureImage}
                    onVisibleCalendarNoteFilesChange={handleVisibleCalendarNoteFilesChange}
                    isRightSidebar={true}
                />
            </div>
        </div>
    );
}
