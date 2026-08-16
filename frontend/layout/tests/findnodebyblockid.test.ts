// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { assert, test } from "vitest";
import { addChildAt, findNodeByBlockId, newLayoutNode } from "../lib/layoutNode";
import { FlexDirection } from "../lib/types";

test("findNodeByBlockId finds a leaf that is the root", () => {
    const root = newLayoutNode(undefined, undefined, undefined, { blockId: "A" });
    assert.equal(findNodeByBlockId(root, "A")?.id, root.id);
});

test("findNodeByBlockId finds a nested leaf", () => {
    const leafA = newLayoutNode(undefined, undefined, undefined, { blockId: "A" });
    const leafB = newLayoutNode(undefined, undefined, undefined, { blockId: "B" });
    const root = newLayoutNode(FlexDirection.Row, undefined, [leafA], undefined);
    addChildAt(root, 1, leafB);
    assert.equal(findNodeByBlockId(root, "B")?.id, leafB.id);
});

test("findNodeByBlockId returns null for an unknown blockId", () => {
    const root = newLayoutNode(undefined, undefined, undefined, { blockId: "A" });
    assert.isNull(findNodeByBlockId(root, "nope"));
});

test("findNodeByBlockId tolerates a null tree", () => {
    assert.isNull(findNodeByBlockId(null, "A"));
});

test("findNodeByBlockId sees a node inserted since the last render pass", () => {
    // this is the regression: the layout model used to look targets up in its `leafs`
    // atom, which is only refreshed inside updateTree() -- so a backend action batch
    // like [insert, split] could not find the node the previous action had just added
    const leafA = newLayoutNode(undefined, undefined, undefined, { blockId: "A" });
    const root = newLayoutNode(FlexDirection.Row, undefined, [leafA], undefined);
    const leafB = newLayoutNode(undefined, undefined, undefined, { blockId: "B" });
    addChildAt(root, 1, leafB);
    assert.isNotNull(findNodeByBlockId(root, "B"), "a freshly inserted node must be findable immediately");
});
