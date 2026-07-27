// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isPathAtOrUnder, normalizeTreePath } from "./directory-tree-utils";

// Validation for dropping files onto a folder. Kept free of React and of react-dnd so the
// rules can be tested directly — the file list, the folder rows, and the tree sidebar all
// share this one implementation rather than growing three copies that drift apart.

export type FolderDropCandidate = {
    // absolute path of the folder the drag started from, when known
    absParent?: string;
    // absolute paths being dragged, when known (a native OS drag knows neither)
    paths?: string[];
};

// canDropOnFolder rejects the no-ops and the destructive impossibilities:
//   - dropping into the folder the items already live in
//   - dropping a folder onto itself
//   - dropping a folder into one of its own descendants
// A drag with no known source paths (native OS drag) is always allowed: the source is
// outside Wave, so none of these cases can apply.
export function canDropOnFolder(targetPath: string, candidate: FolderDropCandidate): boolean {
    const target = normalizeTreePath(targetPath);
    if (target == "") {
        return false;
    }
    if (candidate == null) {
        return true;
    }
    if (candidate.absParent != null && normalizeTreePath(candidate.absParent) == target) {
        return false;
    }
    const paths = candidate.paths ?? [];
    for (const p of paths) {
        if (p == null) {
            continue;
        }
        // isPathAtOrUnder(anchor, current) is true when current is the anchor or inside it,
        // which is exactly "target is the dragged folder, or lives beneath it"
        if (isPathAtOrUnder(p, target)) {
            return false;
        }
    }
    return true;
}

// dropTargetPathsFor returns the source paths a drop should act on, preferring the
// multi-selection payload and falling back to the single dragged uri.
export function dropSourceUris(dragged: { uri?: string; uris?: string[] }): string[] {
    if (dragged == null) {
        return [];
    }
    if (dragged.uris != null && dragged.uris.length > 0) {
        return dragged.uris;
    }
    if (dragged.uri != null) {
        return [dragged.uri];
    }
    return [];
}
