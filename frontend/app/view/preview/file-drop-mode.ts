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
