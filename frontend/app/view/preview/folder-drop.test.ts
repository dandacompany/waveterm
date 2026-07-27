// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canDropOnFolder, dropSourceUris } from "./folder-drop";

describe("canDropOnFolder", () => {
    it("allows a normal drop into a different folder", () => {
        expect(
            canDropOnFolder("/home/dante/dst", { absParent: "/home/dante/src", paths: ["/home/dante/src/a.txt"] })
        ).toBe(true);
    });

    it("rejects dropping into the folder the items already live in", () => {
        expect(
            canDropOnFolder("/home/dante/src", { absParent: "/home/dante/src", paths: ["/home/dante/src/a.txt"] })
        ).toBe(false);
    });

    it("rejects dropping a folder onto itself", () => {
        expect(canDropOnFolder("/home/dante/proj", { absParent: "/home/dante", paths: ["/home/dante/proj"] })).toBe(
            false
        );
    });

    it("rejects dropping a folder into its own descendant", () => {
        expect(
            canDropOnFolder("/home/dante/proj/sub/deep", { absParent: "/home/dante", paths: ["/home/dante/proj"] })
        ).toBe(false);
    });

    it("allows dropping into a sibling that merely shares a name prefix", () => {
        expect(
            canDropOnFolder("/home/dante/project2", { absParent: "/home/dante", paths: ["/home/dante/project"] })
        ).toBe(true);
    });

    it("rejects any drop when one of several dragged folders contains the target", () => {
        expect(
            canDropOnFolder("/home/dante/proj/sub", {
                absParent: "/home/dante",
                paths: ["/home/dante/other.txt", "/home/dante/proj"],
            })
        ).toBe(false);
    });

    it("allows a native OS drag, which knows no source paths", () => {
        expect(canDropOnFolder("/home/dante/dst", {})).toBe(true);
        expect(canDropOnFolder("/home/dante/dst", null)).toBe(true);
    });

    it("rejects an empty target", () => {
        expect(canDropOnFolder("", { paths: ["/a"] })).toBe(false);
        expect(canDropOnFolder(null, { paths: ["/a"] })).toBe(false);
    });

    it("treats trailing slashes as the same folder", () => {
        expect(canDropOnFolder("/home/dante/src/", { absParent: "/home/dante/src" })).toBe(false);
    });

    it("handles a windows drive root as a target", () => {
        expect(canDropOnFolder("C:/", { absParent: "C:/Users", paths: ["C:/Users/file.txt"] })).toBe(true);
        expect(canDropOnFolder("C:/Users/sub", { absParent: "C:/", paths: ["C:/Users"] })).toBe(false);
    });
});

describe("dropSourceUris", () => {
    it("prefers the multi-selection payload", () => {
        expect(dropSourceUris({ uri: "a", uris: ["a", "b"] })).toEqual(["a", "b"]);
    });

    it("falls back to the single dragged uri", () => {
        expect(dropSourceUris({ uri: "a" })).toEqual(["a"]);
    });

    it("returns nothing when there is no payload", () => {
        expect(dropSourceUris({})).toEqual([]);
        expect(dropSourceUris(null)).toEqual([]);
        expect(dropSourceUris({ uris: [] })).toEqual([]);
    });
});
