// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { computeTreeAnchor, isPathAtOrUnder, normalizeTreePath } from "./directory-tree-utils";

describe("normalizeTreePath", () => {
    test("strips trailing slash", () => {
        expect(normalizeTreePath("/home/dante/")).toBe("/home/dante");
    });
    test("keeps root slash", () => {
        expect(normalizeTreePath("/")).toBe("/");
    });
    test("converts backslashes", () => {
        expect(normalizeTreePath("C:\\Users\\dante\\")).toBe("C:/Users/dante");
    });
});

describe("isPathAtOrUnder", () => {
    test("same path is at-or-under", () => {
        expect(isPathAtOrUnder("/a/b", "/a/b")).toBe(true);
    });
    test("child is under", () => {
        expect(isPathAtOrUnder("/a/b", "/a/b/c")).toBe(true);
    });
    test("parent is not under", () => {
        expect(isPathAtOrUnder("/a/b", "/a")).toBe(false);
    });
    test("sibling prefix is not under (no /foo vs /foobar false positive)", () => {
        expect(isPathAtOrUnder("/a/foo", "/a/foobar")).toBe(false);
    });
    test("root is above everything", () => {
        expect(isPathAtOrUnder("/", "/a/b")).toBe(true);
    });
});

describe("computeTreeAnchor", () => {
    test("keeps anchor when current is a descendant", () => {
        expect(computeTreeAnchor("/proj", "/proj/src/app")).toBe("/proj");
    });
    test("keeps anchor when current equals anchor", () => {
        expect(computeTreeAnchor("/proj", "/proj")).toBe("/proj");
    });
    test("rebases up when current is above anchor", () => {
        expect(computeTreeAnchor("/proj/src", "/proj")).toBe("/proj");
    });
    test("rebases out when current is a sibling tree", () => {
        expect(computeTreeAnchor("/proj", "/other/dir")).toBe("/other/dir");
    });
    test("initializes to current when anchor is blank", () => {
        expect(computeTreeAnchor("", "/proj")).toBe("/proj");
        expect(computeTreeAnchor(null, "/proj")).toBe("/proj");
    });
});
