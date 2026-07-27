// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getApi } from "@/store/global";
import { useCallback, useEffect, useRef } from "react";
import { useDrop } from "react-dnd";
import { NativeTypes } from "react-dnd-html5-backend";
import { ensureDropModeTracking, getCurrentDropMode, type DropMode } from "./file-drop-mode";
import { canDropOnFolder, dropSourceUris } from "./folder-drop";

// Hover dwell before a collapsed tree node opens under the cursor — the standard
// affordance for dropping into a subtree without navigating there first.
const HoverExpandDelayMs = 600;

export type FolderDropOpts = {
    // absolute path of the folder being dropped onto
    targetPath: string;
    // performs the transfer for one source uri
    transfer: (srcuri: string, mode: DropMode) => Promise<void>;
    // called after dwelling over a collapsed target, to expand it
    onHoverExpand?: () => void;
};

export type FolderDropResult = {
    isOver: boolean;
    canDrop: boolean;
    dropRef: (el: HTMLElement | null) => void;
};

export function useFolderDrop({ targetPath, transfer, onHoverExpand }: FolderDropOpts): FolderDropResult {
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
    ensureDropModeTracking();

    const clearHoverTimer = useCallback(() => {
        if (hoverTimerRef.current != null) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
    }, []);

    const [{ isOver, canDrop }, drop] = useDrop(
        () => ({
            accept: ["FILE_ITEM", NativeTypes.URL, NativeTypes.FILE],
            canDrop: (_, monitor) => {
                if (!monitor.isOver({ shallow: true })) {
                    return false;
                }
                const item = monitor.getItem<DraggedFile>();
                if (item == null) {
                    return true;
                }
                return canDropOnFolder(targetPath, { absParent: item.absParent, paths: item.paths });
            },
            drop: async (draggedFile: DraggedFile, monitor) => {
                // a nested target already handled this drop; don't transfer twice
                if (monitor.didDrop()) {
                    return;
                }
                clearHoverTimer();
                let srcuris = dropSourceUris(draggedFile);
                if (srcuris.length == 0) {
                    const brokered = await getApi().fileDragGet();
                    if (brokered == null || brokered.uris.length === 0) {
                        return;
                    }
                    srcuris = brokered.uris;
                }
                for (const srcuri of srcuris) {
                    await transfer(srcuri, getCurrentDropMode());
                }
            },
            hover: (_, monitor) => {
                if (onHoverExpand == null || !monitor.isOver({ shallow: true })) {
                    return;
                }
                if (hoverTimerRef.current != null) {
                    return;
                }
                hoverTimerRef.current = setTimeout(() => {
                    hoverTimerRef.current = null;
                    onHoverExpand();
                }, HoverExpandDelayMs);
            },
            collect: (monitor) => ({
                isOver: monitor.isOver({ shallow: true }),
                canDrop: monitor.canDrop(),
            }),
        }),
        [targetPath, transfer, onHoverExpand, clearHoverTimer]
    );

    // the dwell timer must not outlive the hover that started it
    useEffect(() => {
        if (!isOver) {
            clearHoverTimer();
        }
    }, [isOver, clearHoverTimer]);

    useEffect(() => clearHoverTimer, [clearHoverTimer]);

    const dropRef = useCallback(
        (el: HTMLElement | null) => {
            drop(el);
        },
        [drop]
    );

    return { isOver, canDrop, dropRef };
}
