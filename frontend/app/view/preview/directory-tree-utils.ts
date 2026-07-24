// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Normalize a directory path for tree comparisons: backslashes to slashes,
// drop a trailing slash except for a bare root ("/" or a Windows drive root like "C:").
function normalizeTreePath(p: string): string {
    if (p == null || p == "") {
        return "";
    }
    let out = p.replace(/\\/g, "/");
    if (out.length > 1 && out.endsWith("/") && !/^[A-Za-z]:\/$/.test(out)) {
        out = out.slice(0, -1);
    }
    return out;
}

// True when `current` is the same directory as `anchor` or a descendant of it.
// Segment-aware so "/a/foo" is not treated as a parent of "/a/foobar".
function isPathAtOrUnder(anchor: string, current: string): boolean {
    const a = normalizeTreePath(anchor);
    const c = normalizeTreePath(current);
    if (a == "" || c == "") {
        return false;
    }
    if (a == c) {
        return true;
    }
    // a bare root ("/" or a Windows drive root like "C:/") already ends in "/",
    // so a descendant is just a prefix match; other anchors need an explicit "/" boundary.
    const aIsRoot = a == "/" || /^[A-Za-z]:\/$/.test(a);
    if (aIsRoot) {
        return c.startsWith(a);
    }
    return c.startsWith(a + "/");
}

// VSCode-style anchor: keep the anchor while navigating into descendants,
// rebase to `current` when navigating above or outside the anchor subtree.
function computeTreeAnchor(anchor: string, current: string): string {
    const c = normalizeTreePath(current);
    if (anchor == null || anchor == "") {
        return c;
    }
    if (isPathAtOrUnder(anchor, current)) {
        return normalizeTreePath(anchor);
    }
    return c;
}

export { computeTreeAnchor, isPathAtOrUnder, normalizeTreePath };
