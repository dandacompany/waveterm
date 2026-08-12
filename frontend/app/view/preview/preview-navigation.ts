// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export function getSpecializedViewKey(specializedView: string, path: string): string {
    return specializedView === "directory" ? "directory" : path;
}

export type LatestRequestGuard = {
    begin: () => number;
    isCurrent: (requestId: number) => boolean;
    invalidate: (requestId: number) => void;
};

export function createLatestRequestGuard(): LatestRequestGuard {
    let currentRequestId = 0;
    return {
        begin: () => ++currentRequestId,
        isCurrent: (requestId) => requestId === currentRequestId,
        invalidate: (requestId) => {
            if (requestId === currentRequestId) {
                currentRequestId++;
            }
        },
    };
}
