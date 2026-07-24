// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type OpenItem = { kind: "file" | "dir"; path: string } | { kind: "url"; waveUrl: string };

export function parseWaveUrl(url: string): OpenItem | null {
    if (!url.startsWith("wave://")) {
        return null;
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.host !== "open") {
        return null;
    }
    const path = parsed.searchParams.get("path") ?? parsed.searchParams.get("file");
    if (!path) {
        return null;
    }
    return { kind: "file", path };
}

export function parseArgvForOpenItems(argv: string[]): OpenItem[] {
    const items: OpenItem[] = [];
    // skip argv[0] (executable path)
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg || arg === "." || arg.startsWith("-")) {
            continue;
        }
        if (arg.startsWith("wave://")) {
            const waveItem = parseWaveUrl(arg);
            if (waveItem != null) {
                items.push(waveItem);
            }
            continue;
        }
        items.push({ kind: "file", path: arg });
    }
    return items;
}
