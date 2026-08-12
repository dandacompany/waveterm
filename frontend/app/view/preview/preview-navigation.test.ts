// @vitest-environment happy-dom
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { createLatestRequestGuard, getSpecializedViewKey } from "./preview-navigation";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("preview navigation", () => {
    it("keeps the directory preview mounted while the selected folder changes", async () => {
        let mounts = 0;
        let unmounts = 0;
        const container = document.createElement("div");
        const root = createRoot(container);
        const DirectoryShell = () => {
            useEffect(() => {
                mounts++;
                return () => {
                    unmounts++;
                };
            }, []);
            return null;
        };
        const renderPath = (path: string) =>
            root.render(
                createElement(DirectoryShell, {
                    key: getSpecializedViewKey("directory", path),
                })
            );

        await act(() => renderPath("/a"));
        await act(() => renderPath("/a/b"));

        expect(mounts).toBe(1);
        expect(unmounts).toBe(0);
        await act(() => root.unmount());
    });

    it("still remounts path-sensitive non-directory previews", () => {
        expect(getSpecializedViewKey("markdown", "/a.md")).not.toBe(getSpecializedViewKey("markdown", "/b.md"));
    });

    it("accepts only the newest result during rapid directory navigation", () => {
        const guard = createLatestRequestGuard();
        const requestA = guard.begin();
        const requestB = guard.begin();
        const requestC = guard.begin();

        const appliedResults: string[] = [];
        const applyIfCurrent = (requestId: number, path: string) => {
            if (guard.isCurrent(requestId)) {
                appliedResults.push(path);
            }
        };

        applyIfCurrent(requestC, "/c");
        applyIfCurrent(requestB, "/b");
        applyIfCurrent(requestA, "/a");

        expect(appliedResults).toEqual(["/c"]);

        guard.invalidate(requestC);
        expect(guard.isCurrent(requestC)).toBe(false);
    });
});
