// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useState } from "react";
import { isPathAtOrUnder, normalizeTreePath } from "./directory-tree-utils";
import { type PreviewModel } from "./preview-model";

async function loadChildDirs(model: PreviewModel, path: string, showHidden: boolean): Promise<FileInfo[]> {
    const remotePath = await model.formatRemoteUri(path, globalStore.get);
    const stream = model.env.rpc.FileListStreamCommand(TabRpcClient, { path: remotePath }, null);
    const dirs: FileInfo[] = [];
    for await (const chunk of stream) {
        if (!chunk?.fileinfo) {
            continue;
        }
        for (const fi of chunk.fileinfo) {
            if (!fi.isdir) {
                continue;
            }
            if (!showHidden && fi.name?.startsWith(".")) {
                continue;
            }
            dirs.push(fi);
        }
    }
    dirs.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    return dirs;
}

type TreeNodeProps = {
    model: PreviewModel;
    path: string;
    name: string;
    depth: number;
    currentPath: string;
    expanded: Set<string>;
    childrenMap: { [path: string]: FileInfo[] };
    toggle: (path: string) => void;
};

function TreeNode({ model, path, name, depth, currentPath, expanded, childrenMap, toggle }: TreeNodeProps) {
    const isOpen = expanded.has(normalizeTreePath(path));
    const isCurrent = normalizeTreePath(path) == normalizeTreePath(currentPath);
    const children = childrenMap[normalizeTreePath(path)];

    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        ContextMenuModel.getInstance().showContextMenu(
            [
                {
                    label: "Set as Tree Root",
                    click: () => fireAndForget(() => model.setDirTreeRoot(path)),
                },
            ],
            e
        );
    };

    return (
        <div className="dir-tree-node">
            <div
                className={`flex items-center gap-1 px-1 py-0.5 cursor-pointer rounded hover:bg-hoverbg ${isCurrent ? "bg-accent/20 text-accent" : ""}`}
                style={{ paddingLeft: depth * 12 + 4 }}
                onClick={() => fireAndForget(() => model.goHistory(path))}
                onContextMenu={onContextMenu}
            >
                <span
                    className="w-3 shrink-0 text-secondary"
                    onClick={(e) => {
                        e.stopPropagation();
                        toggle(path);
                    }}
                >
                    {isOpen ? "▾" : "▸"}
                </span>
                <span className="truncate">{name}</span>
            </div>
            {isOpen && children != null && (
                <div className="dir-tree-children">
                    {children.map((c) => (
                        <TreeNode
                            key={c.path}
                            model={model}
                            path={c.path}
                            name={c.name}
                            depth={depth + 1}
                            currentPath={currentPath}
                            expanded={expanded}
                            childrenMap={childrenMap}
                            toggle={toggle}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

const DirectoryTree = memo(({ model }: { model: PreviewModel }) => {
    const statFile = useAtomValue(model.statFile);
    const treeRoot = useAtomValue(model.dirTreeRoot);
    const showHidden = useAtomValue(model.showHiddenFiles);
    const currentPath = statFile?.path ?? "";

    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [childrenMap, setChildrenMap] = useState<{ [path: string]: FileInfo[] }>({});

    const anchor = normalizeTreePath(treeRoot != "" ? treeRoot : currentPath);

    const loadInto = async (path: string) => {
        const key = normalizeTreePath(path);
        const dirs = await loadChildDirs(model, path, showHidden);
        setChildrenMap((prev) => ({ ...prev, [key]: dirs }));
    };

    const toggle = (path: string) => {
        const key = normalizeTreePath(path);
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
                if (childrenMap[key] == null) {
                    fireAndForget(() => loadInto(path));
                }
            }
            return next;
        });
    };

    // Load the anchor's children and auto-expand from the anchor down to the current folder (reveal).
    useEffect(() => {
        if (anchor == "" || currentPath == "") {
            return;
        }
        fireAndForget(async () => {
            const toExpand: string[] = [];
            const anchorKey = normalizeTreePath(anchor);
            if (childrenMap[anchorKey] == null) {
                await loadInto(anchor);
            }
            toExpand.push(anchorKey);
            if (isPathAtOrUnder(anchor, currentPath) && anchorKey != normalizeTreePath(currentPath)) {
                // anchorKey may be a bare root that already ends in "/" ("/" or a Windows
                // drive root like "C:/"), so derive the prefix from the key itself instead
                // of special-casing only "/".
                const anchorPrefix = anchorKey.endsWith("/") ? anchorKey : anchorKey + "/";
                const rest = normalizeTreePath(currentPath).slice(anchorPrefix.length);
                const segs = rest.split("/").filter((s) => s != "");
                let acc = anchorKey.endsWith("/") ? anchorKey.slice(0, -1) : anchorKey;
                for (const seg of segs) {
                    acc = acc + "/" + seg;
                    const accKey = normalizeTreePath(acc);
                    if (childrenMap[accKey] == null) {
                        await loadInto(acc);
                    }
                    toExpand.push(accKey);
                }
            }
            setExpanded((prev) => {
                const next = new Set(prev);
                for (const k of toExpand) {
                    next.add(k);
                }
                return next;
            });
        });
    }, [anchor, currentPath, showHidden]);

    if (anchor == "") {
        return <div className="dir-tree-panel p-2 text-secondary text-xs">No folder</div>;
    }

    const anchorName = anchor == "/" ? "/" : anchor.split("/").pop() || anchor;
    return (
        <div className="dir-tree-panel overflow-auto text-sm select-none">
            <TreeNode
                model={model}
                path={anchor}
                name={anchorName}
                depth={0}
                currentPath={currentPath}
                expanded={expanded}
                childrenMap={childrenMap}
                toggle={toggle}
            />
        </div>
    );
});

DirectoryTree.displayName = "DirectoryTree";

export { DirectoryTree };
