// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Selection math for the directory listing, kept free of React so it can be tested
// directly. Selection is keyed by path rather than row index so that it survives a
// refresh, a re-sort, or a change to the search filter.

export type SelectionModifiers = {
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
};

export type SelectionState = {
    paths: Set<string>;
    // index of the row a shift-range extends from; null when there is nothing to extend
    anchorIndex: number;
};

export function emptySelection(): SelectionState {
    return { paths: new Set<string>(), anchorIndex: null };
}

export function isSelected(state: SelectionState, path: string): boolean {
    if (state == null || path == null) {
        return false;
    }
    return state.paths.has(path);
}

export function rangePaths(visiblePaths: string[], fromIdx: number, toIdx: number): string[] {
    if (visiblePaths == null || visiblePaths.length == 0) {
        return [];
    }
    const lo = Math.max(0, Math.min(fromIdx, toIdx));
    const hi = Math.min(visiblePaths.length - 1, Math.max(fromIdx, toIdx));
    if (hi < lo) {
        return [];
    }
    return visiblePaths.slice(lo, hi + 1).filter((p) => p != null);
}

// resolveClick returns the selection produced by clicking row `idx`.
// - plain click: that row alone becomes the selection and the new anchor
// - cmd/ctrl click: toggles that row, leaving the rest intact
// - shift click: replaces the selection with the range from the anchor to that row
export function resolveClick(
    state: SelectionState,
    visiblePaths: string[],
    idx: number,
    mods: SelectionModifiers
): SelectionState {
    const path = visiblePaths?.[idx];
    if (path == null) {
        return state;
    }
    if (mods?.shiftKey && state?.anchorIndex != null) {
        const paths = new Set(rangePaths(visiblePaths, state.anchorIndex, idx));
        return { paths, anchorIndex: state.anchorIndex };
    }
    if (mods?.metaKey || mods?.ctrlKey) {
        const paths = new Set(state?.paths ?? []);
        if (paths.has(path)) {
            paths.delete(path);
        } else {
            paths.add(path);
        }
        return { paths, anchorIndex: idx };
    }
    return { paths: new Set([path]), anchorIndex: idx };
}

export function selectAll(visiblePaths: string[]): SelectionState {
    const paths = new Set((visiblePaths ?? []).filter((p) => p != null));
    return { paths, anchorIndex: paths.size == 0 ? null : 0 };
}

// pruneSelection drops paths that are no longer visible. Entries are kept while they
// remain in the listing, so a refresh that returns the same files preserves the selection.
export function pruneSelection(state: SelectionState, visiblePaths: string[]): SelectionState {
    if (state == null || state.paths.size == 0) {
        return state ?? emptySelection();
    }
    const visible = new Set(visiblePaths ?? []);
    const paths = new Set<string>();
    for (const p of state.paths) {
        if (visible.has(p)) {
            paths.add(p);
        }
    }
    if (paths.size == state.paths.size) {
        return state;
    }
    return { paths, anchorIndex: paths.size == 0 ? null : state.anchorIndex };
}

// dragPaths implements the Finder/Explorer rule: dragging a row that is part of the
// selection drags the whole selection; dragging any other row drags just that row.
export function dragPaths(state: SelectionState, path: string): string[] {
    if (path == null) {
        return [];
    }
    if (!isSelected(state, path)) {
        return [path];
    }
    return Array.from(state.paths);
}
