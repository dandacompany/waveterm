// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    dragPaths,
    emptySelection,
    isSelected,
    pruneSelection,
    rangePaths,
    resolveClick,
    selectAll,
    type SelectionState,
} from "./dir-selection";

const paths = ["/a", "/b", "/c", "/d", "/e"];

function sel(list: string[], anchorIndex: number = null): SelectionState {
    return { paths: new Set(list), anchorIndex };
}

describe("resolveClick", () => {
    it("plain click selects only that row and sets the anchor", () => {
        const s = resolveClick(sel(["/a", "/b"], 0), paths, 3, {});
        expect(Array.from(s.paths)).toEqual(["/d"]);
        expect(s.anchorIndex).toBe(3);
    });

    it("cmd-click adds to the selection", () => {
        const s = resolveClick(sel(["/a"], 0), paths, 2, { metaKey: true });
        expect(Array.from(s.paths).sort()).toEqual(["/a", "/c"]);
        expect(s.anchorIndex).toBe(2);
    });

    it("cmd-click removes an already-selected row", () => {
        const s = resolveClick(sel(["/a", "/c"], 0), paths, 2, { metaKey: true });
        expect(Array.from(s.paths)).toEqual(["/a"]);
    });

    it("ctrl-click behaves like cmd-click", () => {
        const s = resolveClick(sel(["/a"], 0), paths, 1, { ctrlKey: true });
        expect(Array.from(s.paths).sort()).toEqual(["/a", "/b"]);
    });

    it("shift-click selects the range from the anchor", () => {
        const s = resolveClick(sel(["/b"], 1), paths, 3, { shiftKey: true });
        expect(Array.from(s.paths)).toEqual(["/b", "/c", "/d"]);
        expect(s.anchorIndex).toBe(1);
    });

    it("shift-click extends backwards too", () => {
        const s = resolveClick(sel(["/d"], 3), paths, 1, { shiftKey: true });
        expect(Array.from(s.paths)).toEqual(["/b", "/c", "/d"]);
    });

    it("shift-click with no anchor falls back to a plain click", () => {
        const s = resolveClick(emptySelection(), paths, 2, { shiftKey: true });
        expect(Array.from(s.paths)).toEqual(["/c"]);
        expect(s.anchorIndex).toBe(2);
    });

    it("ignores a click on a row that does not exist", () => {
        const before = sel(["/a"], 0);
        expect(resolveClick(before, paths, 99, {})).toBe(before);
    });
});

describe("rangePaths", () => {
    it("clamps out-of-range indices", () => {
        expect(rangePaths(paths, -5, 1)).toEqual(["/a", "/b"]);
        expect(rangePaths(paths, 3, 99)).toEqual(["/d", "/e"]);
    });

    it("returns a single element when from equals to", () => {
        expect(rangePaths(paths, 2, 2)).toEqual(["/c"]);
    });

    it("returns nothing for an empty list", () => {
        expect(rangePaths([], 0, 3)).toEqual([]);
    });
});

describe("selectAll", () => {
    it("selects every visible path", () => {
        const s = selectAll(paths);
        expect(s.paths.size).toBe(5);
        expect(s.anchorIndex).toBe(0);
    });

    it("leaves no anchor for an empty listing", () => {
        expect(selectAll([]).anchorIndex).toBeNull();
    });
});

describe("pruneSelection", () => {
    it("keeps the selection when the listing is unchanged — a refresh must not clear it", () => {
        const before = sel(["/a", "/c"], 0);
        expect(pruneSelection(before, paths)).toBe(before);
    });

    it("drops entries that disappeared from the listing", () => {
        const s = pruneSelection(sel(["/a", "/zz"], 0), paths);
        expect(Array.from(s.paths)).toEqual(["/a"]);
    });

    it("clears the anchor once nothing remains selected", () => {
        const s = pruneSelection(sel(["/zz"], 2), paths);
        expect(s.paths.size).toBe(0);
        expect(s.anchorIndex).toBeNull();
    });
});

describe("dragPaths", () => {
    it("drags the whole selection when the dragged row is part of it", () => {
        expect(dragPaths(sel(["/a", "/b"]), "/b").sort()).toEqual(["/a", "/b"]);
    });

    it("drags only the row when it is outside the selection", () => {
        expect(dragPaths(sel(["/a", "/b"]), "/d")).toEqual(["/d"]);
    });

    it("handles a null path", () => {
        expect(dragPaths(sel(["/a"]), null)).toEqual([]);
    });
});

describe("isSelected", () => {
    it("is false for null inputs", () => {
        expect(isSelected(null, "/a")).toBe(false);
        expect(isSelected(emptySelection(), null)).toBe(false);
    });
});
