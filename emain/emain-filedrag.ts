// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type FileDragPayload = { uris: string[]; sourceConn: string; isDir: boolean };

let currentDrag: FileDragPayload | null = null;

export function setCurrentDrag(payload: FileDragPayload): void {
    currentDrag = payload;
}

export function clearCurrentDrag(): void {
    currentDrag = null;
}

export function getCurrentDrag(): FileDragPayload | null {
    return currentDrag;
}
