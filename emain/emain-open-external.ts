// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import fs from "fs";
import { OpenItem } from "./emain-open-external-parse";
import { createNewWaveWindow, focusedWaveWindow, getAllWaveWindows, WaveBrowserWindow } from "./emain-window";

const SupportedExtensions = new Set([
    "md",
    "txt",
    "pdf",
    "csv",
    "json",
    "log",
    "xml",
    "yaml",
    "yml",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "svg",
    "webp",
    "bmp",
    "js",
    "ts",
    "jsx",
    "tsx",
    "py",
    "go",
    "rs",
    "c",
    "cpp",
    "h",
    "java",
    "sh",
    "toml",
    "ini",
]);

let appReady = false;
let buffer: OpenItem[] = [];
let nativeOpenEnabled = true;

export function setNativeOpenEnabled(enabled: boolean): void {
    nativeOpenEnabled = enabled;
}

function isSupportedFile(path: string): boolean {
    const dotIdx = path.lastIndexOf(".");
    if (dotIdx < 0) {
        return false;
    }
    return SupportedExtensions.has(path.slice(dotIdx + 1).toLowerCase());
}

function resolveItem(item: OpenItem): { path: string } | null {
    if (item.kind === "url") {
        return null; // wave urls are already parsed to file/dir by the parser
    }
    let stat: fs.Stats;
    try {
        stat = fs.statSync(item.path);
    } catch {
        console.log("open-external: path does not exist, skipping", item.path);
        return null;
    }
    if (stat.isDirectory()) {
        return { path: item.path };
    }
    if (!isSupportedFile(item.path)) {
        console.log("open-external: unsupported file type, skipping", item.path);
        return null;
    }
    return { path: item.path };
}

async function resolveTargetWindow(): Promise<WaveBrowserWindow> {
    const existing = focusedWaveWindow ?? getAllWaveWindows()[0];
    if (existing != null && !existing.isDestroyed()) {
        return existing;
    }
    await createNewWaveWindow();
    return getAllWaveWindows()[0];
}

export async function openExternalPaths(items: OpenItem[]): Promise<void> {
    if (!nativeOpenEnabled) {
        return;
    }
    const resolved = items.map(resolveItem).filter((x) => x != null);
    if (resolved.length === 0) {
        return;
    }
    const win = await resolveTargetWindow();
    if (win == null) {
        return;
    }
    for (const r of resolved) {
        await win.openBlockInNewTab({ view: "preview", file: r.path });
    }
    win.show();
    win.focus();
}

export function bufferOrOpen(items: OpenItem[]): void {
    if (!nativeOpenEnabled) {
        return;
    }
    if (items.length === 0) {
        return;
    }
    if (!appReady) {
        buffer.push(...items);
        return;
    }
    fireAndForget(() => openExternalPaths(items));
}

export async function flushBufferedOpens(): Promise<void> {
    appReady = true;
    const pending = buffer;
    buffer = [];
    if (pending.length > 0) {
        await openExternalPaths(pending);
    }
}
