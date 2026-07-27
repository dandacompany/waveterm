// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type DropMode = "copy" | "move";

export function resolveDropMode(e: { metaKey?: boolean; ctrlKey?: boolean }): DropMode {
    if (e.metaKey || e.ctrlKey) {
        return "move";
    }
    return "copy";
}

export function dropHintLabel(mode: DropMode, destDir: string): string {
    const verb = mode === "move" ? "Move" : "Copy";
    return `${verb} to ${destDir}`;
}

// Every folder row and tree node is a drop target, so modifier state is tracked once at
// module level rather than one keyboard listener per target. Listeners attach on first
// use and stay for the life of the window.
let currentDropMode: DropMode = "copy";
let dropModeListenersAttached = false;

function onDropModeKey(e: KeyboardEvent) {
    currentDropMode = resolveDropMode({ metaKey: e.metaKey, ctrlKey: e.ctrlKey });
}

export function ensureDropModeTracking(): void {
    if (dropModeListenersAttached || typeof window == "undefined") {
        return;
    }
    dropModeListenersAttached = true;
    window.addEventListener("keydown", onDropModeKey);
    window.addEventListener("keyup", onDropModeKey);
}

export function getCurrentDropMode(): DropMode {
    return currentDropMode;
}
