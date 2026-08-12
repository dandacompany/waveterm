// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { BookmarksModel } from "@/app/store/bookmarksmodel";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { checkKeyPressed, isCharacterKeyEvent } from "@/util/keyutil";
import { PLATFORM, PlatformMacOS } from "@/util/platformutil";
import { addOpenMenuItems } from "@/util/previewutil";
import { fireAndForget } from "@/util/util";
import { formatRemoteUri } from "@/util/waveutil";
import { offset, useDismiss, useFloating, useInteractions } from "@floating-ui/react";
import {
    Header,
    Row,
    RowData,
    Table,
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getSortedRowModel,
    useReactTable,
} from "@tanstack/react-table";
import clsx from "clsx";
import { PrimitiveAtom, atom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { OverlayScrollbarsComponent, OverlayScrollbarsComponentRef } from "overlayscrollbars-react";
import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDrag, useDrop } from "react-dnd";
import { NativeTypes } from "react-dnd-html5-backend";
import { quote as shellQuote } from "shell-quote";
import { debounce } from "throttle-debounce";
import { v7 as uuidv7 } from "uuid";
import {
    dragPaths,
    emptySelection,
    isSelected as isPathSelected,
    pruneSelection,
    resolveClick,
    selectAll,
    type SelectionState,
} from "./dir-selection";
import { DirectoryTree } from "./directory-tree";
import { computeTreeAnchor } from "./directory-tree-utils";
import "./directorypreview.scss";
import { EntryManagerOverlay, EntryManagerOverlayProps, EntryManagerType } from "./entry-manager";
import { DropMode, dropHintLabel, resolveDropMode } from "./file-drop-mode";
import {
    cleanMimetype,
    getBestUnit,
    getLastModifiedTime,
    getSortIcon,
    handleFileDelete,
    handleRename,
    isIconValid,
    makeDirectoryDefaultMenuItems,
    mergeError,
    overwriteError,
} from "./preview-directory-utils";
import { type PreviewModel } from "./preview-model";
import { createLatestRequestGuard } from "./preview-navigation";
import type { PreviewEnv } from "./previewenv";
import { useFolderDrop } from "./use-folder-drop";

const PageJumpSize = 20;
const EmptyDirectoryData: FileInfo[] = [];

interface DirectoryTableHeaderCellProps {
    header: Header<FileInfo, unknown>;
}

function DirectoryTableHeaderCell({ header }: DirectoryTableHeaderCellProps) {
    return (
        <div
            className="dir-table-head-cell"
            key={header.id}
            style={{ width: `calc(var(--header-${header.id}-size) * 1px)` }}
        >
            <div className="dir-table-head-cell-content" onClick={() => header.column.toggleSorting()}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                {getSortIcon(header.column.getIsSorted())}
            </div>
            <div className="dir-table-head-resize-box">
                <div
                    className="dir-table-head-resize"
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                />
            </div>
        </div>
    );
}

declare module "@tanstack/react-table" {
    interface TableMeta<TData extends RowData> {
        updateName: (path: string, isDir: boolean) => void;
        newFile: () => void;
        newDirectory: () => void;
    }
}

interface DirectoryTableProps {
    model: PreviewModel;
    data: FileInfo[];
    search: string;
    selection: SelectionState;
    setSelection: React.Dispatch<React.SetStateAction<SelectionState>>;
    focusIndex: number;
    setFocusIndex: (_: number) => void;
    setSearch: (_: string) => void;
    setSelectedPath: (_: string) => void;
    setRefreshVersion: React.Dispatch<React.SetStateAction<number>>;
    entryManagerOverlayPropsAtom: PrimitiveAtom<EntryManagerOverlayProps>;
    newFile: () => void;
    newDirectory: () => void;
}

const columnHelper = createColumnHelper<FileInfo>();

function DirectoryTable({
    model,
    data,
    search,
    selection,
    setSelection,
    focusIndex,
    setFocusIndex,
    setSearch,
    setSelectedPath,
    setRefreshVersion,
    entryManagerOverlayPropsAtom,
    newFile,
    newDirectory,
}: DirectoryTableProps) {
    const env = useWaveEnv<PreviewEnv>();
    const fullConfig = useAtomValue(env.atoms.fullConfigAtom);
    const defaultSort = useAtomValue(env.getSettingsKeyAtom("preview:defaultsort")) ?? "name";
    const setErrorMsg = useSetAtom(model.errorMsgAtom);
    const getIconFromMimeType = useCallback(
        (mimeType: string): string => {
            while (mimeType.length > 0) {
                const icon = fullConfig.mimetypes?.[mimeType]?.icon ?? null;
                if (isIconValid(icon)) {
                    return `fa fa-solid fa-${icon} fa-fw`;
                }
                mimeType = mimeType.slice(0, -1);
            }
            return "fa fa-solid fa-file fa-fw";
        },
        [fullConfig.mimetypes]
    );
    const getIconColor = useCallback(
        (mimeType: string): string => fullConfig.mimetypes?.[mimeType]?.color ?? "inherit",
        [fullConfig.mimetypes]
    );
    const columns = useMemo(
        () => [
            columnHelper.accessor("mimetype", {
                cell: (info) => (
                    <i
                        className={getIconFromMimeType(info.getValue() ?? "")}
                        style={{ color: getIconColor(info.getValue() ?? "") }}
                    ></i>
                ),
                header: () => <span></span>,
                id: "logo",
                size: 25,
                enableSorting: false,
            }),
            columnHelper.accessor("name", {
                cell: (info) => <span className="dir-table-name ellipsis">{info.getValue()}</span>,
                header: () => <span className="dir-table-head-name">Name</span>,
                sortingFn: "alphanumeric",
                size: 200,
                minSize: 90,
            }),
            columnHelper.accessor("modestr", {
                cell: (info) => <span className="dir-table-modestr">{info.getValue()}</span>,
                header: () => <span>Perm</span>,
                size: 91,
                minSize: 90,
                sortingFn: "alphanumeric",
            }),
            columnHelper.accessor("modtime", {
                cell: (info) => <span className="dir-table-lastmod">{getLastModifiedTime(info.getValue())}</span>,
                header: () => <span>Last Modified</span>,
                size: 91,
                minSize: 65,
                sortingFn: "datetime",
            }),
            columnHelper.accessor("size", {
                cell: (info) => <span className="dir-table-size">{getBestUnit(info.getValue())}</span>,
                header: () => <span className="dir-table-head-size">Size</span>,
                size: 55,
                minSize: 50,
                sortingFn: "auto",
            }),
            columnHelper.accessor("mimetype", {
                cell: (info) => <span className="dir-table-type ellipsis">{cleanMimetype(info.getValue() ?? "")}</span>,
                header: () => <span className="dir-table-head-type">Type</span>,
                size: 97,
                minSize: 97,
                sortingFn: "alphanumeric",
            }),
            columnHelper.accessor("path", {}),
        ],
        [fullConfig]
    );

    const setEntryManagerProps = useSetAtom(entryManagerOverlayPropsAtom);

    const updateName = useCallback(
        (path: string, isDir: boolean) => {
            const fileName = path.split("/").at(-1);
            setEntryManagerProps({
                entryManagerType: EntryManagerType.EditName,
                startingValue: fileName,
                onSave: (newName: string) => {
                    let newPath: string;
                    if (newName !== fileName) {
                        const lastInstance = path.lastIndexOf(fileName);
                        newPath = path.substring(0, lastInstance) + newName;
                        console.log(`replacing ${fileName} with ${newName}: ${path}`);
                        handleRename(model, path, newPath, isDir, setErrorMsg);
                    }
                    setEntryManagerProps(undefined);
                },
            });
        },
        [model, setErrorMsg]
    );

    const initialSorting = defaultSort === "modtime" ? [{ id: "modtime", desc: true }] : [{ id: "name", desc: false }];

    const table = useReactTable({
        data,
        columns,
        columnResizeMode: "onChange",
        getSortedRowModel: getSortedRowModel(),
        getCoreRowModel: getCoreRowModel(),

        initialState: {
            sorting: initialSorting,
            columnVisibility: {
                path: false,
            },
        },
        enableMultiSort: false,
        enableSortingRemoval: false,
        meta: {
            updateName,
            newFile,
            newDirectory,
        },
    });
    const sortingState = table.getState().sorting;
    useEffect(() => {
        const allRows = table.getRowModel()?.flatRows || [];
        setSelectedPath((allRows[focusIndex]?.getValue("path") as string) ?? null);
    }, [focusIndex, data, setSelectedPath, sortingState]);

    const columnSizeVars = useMemo(() => {
        const headers = table.getFlatHeaders();
        const colSizes: { [key: string]: number } = {};
        for (let i = 0; i < headers.length; i++) {
            const header = headers[i]!;
            colSizes[`--header-${header.id}-size`] = header.getSize();
            colSizes[`--col-${header.column.id}-size`] = header.column.getSize();
        }
        return colSizes;
    }, [table.getState().columnSizingInfo]);

    const osRef = useRef<OverlayScrollbarsComponentRef>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const [scrollHeight, setScrollHeight] = useState(0);

    const onScroll = useCallback(
        debounce(2, () => {
            setScrollHeight(osRef.current.osInstance().elements().viewport.scrollTop);
        }),
        []
    );

    const TableComponent = table.getState().columnSizingInfo.isResizingColumn ? MemoizedTableBody : TableBody;

    return (
        <OverlayScrollbarsComponent
            options={{ scrollbars: { autoHide: "leave" } }}
            events={{ scroll: onScroll }}
            className="dir-table"
            style={{ ...columnSizeVars }}
            ref={osRef}
            data-scroll-height={scrollHeight}
        >
            <div className="dir-table-head">
                {table.getHeaderGroups().map((headerGroup) => (
                    <div className="dir-table-head-row" key={headerGroup.id}>
                        {headerGroup.headers.map((header) => (
                            <DirectoryTableHeaderCell key={header.id} header={header} />
                        ))}
                    </div>
                ))}
            </div>
            <TableComponent
                bodyRef={bodyRef}
                model={model}
                data={data}
                table={table}
                search={search}
                selection={selection}
                setSelection={setSelection}
                focusIndex={focusIndex}
                setFocusIndex={setFocusIndex}
                setSearch={setSearch}
                setSelectedPath={setSelectedPath}
                setRefreshVersion={setRefreshVersion}
                osRef={osRef.current}
            />
        </OverlayScrollbarsComponent>
    );
}

interface TableBodyProps {
    bodyRef: React.RefObject<HTMLDivElement>;
    model: PreviewModel;
    data: Array<FileInfo>;
    table: Table<FileInfo>;
    search: string;
    selection: SelectionState;
    setSelection: React.Dispatch<React.SetStateAction<SelectionState>>;
    focusIndex: number;
    setFocusIndex: (_: number) => void;
    setSearch: (_: string) => void;
    setSelectedPath: (_: string) => void;
    setRefreshVersion: React.Dispatch<React.SetStateAction<number>>;
    osRef: OverlayScrollbarsComponentRef;
}

function TableBody({
    bodyRef,
    model,
    table,
    search,
    selection,
    setSelection,
    focusIndex,
    setFocusIndex,
    setSearch,
    setRefreshVersion,
    osRef,
}: TableBodyProps) {
    const searchActive = useAtomValue(model.directorySearchActive);
    const dummyLineRef = useRef<HTMLDivElement>(null);
    const warningBoxRef = useRef<HTMLDivElement>(null);
    const conn = useAtomValue(model.connection);
    const setErrorMsg = useSetAtom(model.errorMsgAtom);

    useEffect(() => {
        if (focusIndex === null || !bodyRef.current || !osRef) {
            return;
        }

        const rowElement = bodyRef.current.querySelector(`[data-rowindex="${focusIndex}"]`) as HTMLDivElement;
        if (!rowElement) {
            return;
        }

        const viewport = osRef.osInstance().elements().viewport;
        const viewportHeight = viewport.offsetHeight;
        const rowRect = rowElement.getBoundingClientRect();
        const parentRect = viewport.getBoundingClientRect();
        const viewportScrollTop = viewport.scrollTop;
        const rowTopRelativeToViewport = rowRect.top - parentRect.top + viewport.scrollTop;
        const rowBottomRelativeToViewport = rowRect.bottom - parentRect.top + viewport.scrollTop;

        if (rowTopRelativeToViewport - 30 < viewportScrollTop) {
            // Row is above the visible area
            let topVal = rowTopRelativeToViewport - 30;
            if (topVal < 0) {
                topVal = 0;
            }
            viewport.scrollTo({ top: topVal });
        } else if (rowBottomRelativeToViewport + 5 > viewportScrollTop + viewportHeight) {
            // Row is below the visible area
            const topVal = rowBottomRelativeToViewport - viewportHeight + 5;
            viewport.scrollTo({ top: topVal });
        }
    }, [focusIndex]);

    const visiblePaths = table.getRowModel().flatRows.map((r) => r.getValue("path") as string);

    const handleRowClick = useCallback(
        (idx: number, e: React.MouseEvent) => {
            setFocusIndex(idx);
            setSelection((cur) =>
                resolveClick(cur, visiblePaths, idx, {
                    metaKey: e.metaKey,
                    ctrlKey: e.ctrlKey,
                    shiftKey: e.shiftKey,
                })
            );
        },
        [visiblePaths, setFocusIndex, setSelection]
    );

    const handleFileContextMenu = useCallback(
        async (e: any, finfo: FileInfo) => {
            e.preventDefault();
            e.stopPropagation();
            if (finfo == null) {
                return;
            }
            const fileName = finfo.path.split("/").pop();
            const selectedPaths = isPathSelected(selection, finfo.path) ? Array.from(selection.paths) : [finfo.path];
            const multi = selectedPaths.length > 1;
            const menu: ContextMenuItem[] = [
                {
                    label: "New File",
                    click: () => {
                        table.options.meta.newFile();
                    },
                },
                {
                    label: "New Folder",
                    click: () => {
                        table.options.meta.newDirectory();
                    },
                },
                {
                    label: "Rename",
                    click: () => {
                        table.options.meta.updateName(finfo.path, finfo.isdir);
                    },
                },
                {
                    type: "separator",
                },
                {
                    label: "Copy File Name",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(fileName)),
                },
                {
                    label: multi ? `Copy ${selectedPaths.length} Full File Names` : "Copy Full File Name",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(selectedPaths.join("\n"))),
                },
                {
                    label: "Copy File Name (Shell Quoted)",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote([fileName]))),
                },
                {
                    label: "Copy Full File Name (Shell Quoted)",
                    click: () => fireAndForget(() => navigator.clipboard.writeText(shellQuote([finfo.path]))),
                },
            ];
            menu.push(
                { type: "separator" },
                {
                    label: "Add to Bookmarks",
                    click: () =>
                        fireAndForget(() =>
                            BookmarksModel.getInstance().add({
                                bookmarktype: finfo.isdir ? "folder" : "file",
                                label: fileName,
                                path: finfo.path,
                                connection: conn ?? "",
                            } as FileBookmark)
                        ),
                }
            );
            addOpenMenuItems(menu, conn, finfo);
            menu.push(
                {
                    type: "separator",
                },
                {
                    label: "Default Settings",
                    submenu: makeDirectoryDefaultMenuItems(model),
                },
                {
                    type: "separator",
                },
                {
                    label: multi ? `Delete ${selectedPaths.length} Items` : "Delete",
                    click: () => {
                        for (const p of selectedPaths) {
                            handleFileDelete(model, p, false, setErrorMsg);
                        }
                    },
                }
            );
            ContextMenuModel.getInstance().showContextMenu(menu, e);
        },
        [setRefreshVersion, conn, selection]
    );

    const allRows = table.getRowModel().flatRows;
    const dotdotRow = allRows.find((row) => row.getValue("name") === "..");
    const otherRows = allRows.filter((row) => row.getValue("name") !== "..");

    return (
        <div className="dir-table-body" ref={bodyRef}>
            {(searchActive || search !== "") && (
                <div className="flex rounded-[3px] py-1 px-2 bg-warning text-black" ref={warningBoxRef}>
                    <span>{search === "" ? "Type to search (Esc to cancel)" : `Searching for "${search}"`}</span>
                    <div
                        className="ml-auto bg-transparent flex justify-center items-center flex-col p-0.5 rounded-md hover:bg-hoverbg focus:bg-hoverbg focus-within:bg-hoverbg cursor-pointer"
                        onClick={() => {
                            setSearch("");
                            globalStore.set(model.directorySearchActive, false);
                        }}
                    >
                        <i className="fa-solid fa-xmark" />
                        <input
                            type="text"
                            value={search}
                            onChange={() => {}}
                            className="w-0 h-0 opacity-0 p-0 border-none pointer-events-none"
                        />
                    </div>
                </div>
            )}
            <div className="dir-table-body-scroll-box">
                <div className="dummy dir-table-body-row" ref={dummyLineRef}>
                    <div className="dir-table-body-cell">dummy-data</div>
                </div>
                {dotdotRow && (
                    <TableRow
                        model={model}
                        row={dotdotRow}
                        focusIndex={focusIndex}
                        setFocusIndex={setFocusIndex}
                        setSearch={setSearch}
                        idx={0}
                        selection={selection}
                        onRowClick={handleRowClick}
                        handleFileContextMenu={handleFileContextMenu}
                        key="dotdot"
                    />
                )}
                {otherRows.map((row, idx) => (
                    <TableRow
                        model={model}
                        row={row}
                        focusIndex={focusIndex}
                        setFocusIndex={setFocusIndex}
                        setSearch={setSearch}
                        idx={dotdotRow ? idx + 1 : idx}
                        selection={selection}
                        onRowClick={handleRowClick}
                        handleFileContextMenu={handleFileContextMenu}
                        key={idx}
                    />
                ))}
            </div>
        </div>
    );
}

type TableRowProps = {
    model: PreviewModel;
    row: Row<FileInfo>;
    focusIndex: number;
    setFocusIndex: (_: number) => void;
    setSearch: (_: string) => void;
    idx: number;
    selection: SelectionState;
    onRowClick: (idx: number, e: React.MouseEvent) => void;
    handleFileContextMenu: (e: any, finfo: FileInfo) => Promise<void>;
};

function TableRow({
    model,
    row,
    focusIndex,
    setFocusIndex,
    setSearch,
    idx,
    selection,
    onRowClick,
    handleFileContextMenu,
}: TableRowProps) {
    const dirPath = useAtomValue(model.statFilePath);
    const connection = useAtomValue(model.connection);

    const dragItem: DraggedFile = {
        relName: row.getValue("name") as string,
        absParent: dirPath,
        uri: formatRemoteUri(row.getValue("path") as string, connection),
        isDir: row.original.isdir,
    };
    const [_, drag] = useDrag(
        () => ({
            type: "FILE_ITEM",
            canDrag: true,
            item: () => {
                // dragging a selected row drags the whole selection (Finder/Explorer rule)
                const paths = dragPaths(selection, row.getValue("path") as string);
                const uris = paths.map((p) => formatRemoteUri(p, connection));
                getApi().fileDragStart({ uris, sourceConn: connection ?? "", isDir: dragItem.isDir });
                return { ...dragItem, uris, paths };
            },
            end: () => {
                getApi().fileDragEnd();
            },
        }),
        [dragItem, connection, selection, row]
    );

    const rowPath = row.getValue("path") as string;
    const isFolderTarget = row.original.isdir;
    const {
        isOver: folderIsOver,
        canDrop: folderCanDrop,
        dropRef: folderDropRef,
    } = useFolderDrop({
        targetPath: isFolderTarget ? rowPath : "",
        transfer: useCallback(
            (srcuri: string, mode: DropMode) =>
                model.folderTransferCallback?.(srcuri, rowPath, mode) ?? Promise.resolve(),
            [model, rowPath]
        ),
    });

    const dragRef = useCallback(
        (node: HTMLDivElement | null) => {
            drag(node);
            if (isFolderTarget) {
                folderDropRef(node);
            }
        },
        [drag, folderDropRef, isFolderTarget]
    );

    return (
        <div
            className={clsx("dir-table-body-row", {
                focused: focusIndex === idx,
                selected: isPathSelected(selection, rowPath),
                "drop-target": isFolderTarget && folderIsOver && folderCanDrop,
            })}
            data-rowindex={idx}
            onDoubleClick={() => {
                const newFileName = row.getValue("path") as string;
                model.goHistory(newFileName);
                setSearch("");
                globalStore.set(model.directorySearchActive, false);
            }}
            onClick={(e) => onRowClick(idx, e)}
            onContextMenu={(e) => handleFileContextMenu(e, row.original)}
            onDragStart={(e) => {
                e.dataTransfer.setData("text/uri-list", dragItem.uri);
            }}
            ref={dragRef}
        >
            {row.getVisibleCells().map((cell) => (
                <div
                    className={clsx("dir-table-body-cell", "col-" + cell.column.id)}
                    key={cell.id}
                    style={{ width: `calc(var(--col-${cell.column.id}-size) * 1px)` }}
                >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
            ))}
        </div>
    );
}

const MemoizedTableBody = React.memo(
    TableBody,
    (prev, next) => prev.table.options.data == next.table.options.data
) as typeof TableBody;

interface DirectoryPreviewProps {
    model: PreviewModel;
}

function DirectoryPreview({ model }: DirectoryPreviewProps) {
    const env = useWaveEnv<PreviewEnv>();
    const [searchText, setSearchText] = useState("");
    const [focusIndex, setFocusIndex] = useState(0);
    const [selection, setSelection] = useState<SelectionState>(emptySelection);
    const [unfilteredData, setUnfilteredData] = useState<FileInfo[]>([]);
    const [loadedDirLocation, setLoadedDirLocation] = useState<{ conn: string; path: string }>(null);
    const listRequestGuardRef = useRef(createLatestRequestGuard());
    const showHiddenFiles = useAtomValue(model.showHiddenFiles);
    const [selectedPath, setSelectedPath] = useState("");
    const [refreshVersion, setRefreshVersion] = useAtom(model.refreshVersion);
    const conn = useAtomValue(model.connection);
    const blockData = useAtomValue(model.blockAtom);
    const finfo = useAtomValue(model.statFile);
    const dirPath = finfo?.path;
    const setErrorMsg = useSetAtom(model.errorMsgAtom);
    const dropModeRef = useRef<DropMode>("copy");
    const [dropHint, setDropHint] = useState<string>(null);
    const [copyProgress, setCopyProgress] = useState<{ name: string; bytes: number; total: number }>(null);
    const treeView = useAtomValue(model.dirTreeView);
    const treeRoot = useAtomValue(model.dirTreeRoot);

    useEffect(() => {
        if (!treeView || dirPath == null || dirPath == "") {
            return;
        }
        const nextAnchor = computeTreeAnchor(treeRoot, dirPath);
        if (nextAnchor != treeRoot) {
            fireAndForget(() => model.setDirTreeRoot(nextAnchor));
        }
    }, [treeView, treeRoot, dirPath]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            dropModeRef.current = resolveDropMode({ metaKey: e.metaKey, ctrlKey: e.ctrlKey });
            setDropHint((h) => (h == null ? h : dropHintLabel(dropModeRef.current, dirPath)));
        };
        window.addEventListener("keydown", onKey);
        window.addEventListener("keyup", onKey);
        return () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("keyup", onKey);
        };
    }, [dirPath]);

    useEffect(() => {
        model.refreshCallback = () => {
            setRefreshVersion((refreshVersion) => refreshVersion + 1);
        };
        return () => {
            model.refreshCallback = null;
        };
    }, [setRefreshVersion]);

    useEffect(() => {
        const requestGuard = listRequestGuardRef.current;
        const requestId = requestGuard.begin();
        fireAndForget(async () => {
            if (dirPath == null) {
                if (requestGuard.isCurrent(requestId)) {
                    setUnfilteredData([]);
                    setLoadedDirLocation(null);
                }
                return;
            }
            const entries: FileInfo[] = [];
            try {
                const remotePath = await model.formatRemoteUri(dirPath, globalStore.get);
                const stream = env.rpc.FileListStreamCommand(TabRpcClient, { path: remotePath }, null);
                for await (const chunk of stream) {
                    if (chunk?.fileinfo) {
                        entries.push(...chunk.fileinfo);
                    }
                }
                if (finfo?.dir && finfo?.path !== finfo?.dir) {
                    entries.unshift({
                        name: "..",
                        path: finfo.dir,
                        isdir: true,
                        modtime: new Date().getTime(),
                        mimetype: "directory",
                    });
                }
            } catch (e) {
                if (!requestGuard.isCurrent(requestId)) {
                    return;
                }
                console.error("Directory Read Error", e);
                setErrorMsg({
                    status: "Cannot Read Directory",
                    text: `${e}`,
                });
            }
            if (requestGuard.isCurrent(requestId)) {
                setUnfilteredData(entries);
                setLoadedDirLocation({ conn, path: dirPath });
            }
        });
        return () => requestGuard.invalidate(requestId);
    }, [conn, dirPath, finfo?.dir, refreshVersion]);

    const visibleData =
        loadedDirLocation?.conn === conn && loadedDirLocation?.path === dirPath ? unfilteredData : EmptyDirectoryData;

    const filteredData = useMemo(
        () =>
            visibleData.filter((fileInfo) => {
                if (fileInfo.name == null) {
                    console.log("fileInfo.name is null", fileInfo);
                    return false;
                }
                if (!showHiddenFiles && fileInfo.name.startsWith(".") && fileInfo.name != "..") {
                    return false;
                }
                return fileInfo.name.toLowerCase().includes(searchText);
            }) ?? [],
        [visibleData, showHiddenFiles, searchText]
    );

    useEffect(() => {
        model.directoryKeyDownHandler = (waveEvent: WaveKeyboardEvent): boolean => {
            if (checkKeyPressed(waveEvent, "Cmd:f")) {
                globalStore.set(model.directorySearchActive, true);
                return true;
            }
            if (checkKeyPressed(waveEvent, "Cmd:a")) {
                setSelection(selectAll(filteredData.map((f) => f.path)));
                return true;
            }
            if (checkKeyPressed(waveEvent, "Escape")) {
                // clear the selection first so Escape doesn't also drop an active search
                if (selection.paths.size > 0) {
                    setSelection(emptySelection());
                    return true;
                }
                setSearchText("");
                globalStore.set(model.directorySearchActive, false);
                return;
            }
            if (checkKeyPressed(waveEvent, "ArrowUp")) {
                setFocusIndex((idx) => Math.max(idx - 1, 0));
                return true;
            }
            if (checkKeyPressed(waveEvent, "ArrowDown")) {
                setFocusIndex((idx) => Math.min(idx + 1, filteredData.length - 1));
                return true;
            }
            if (checkKeyPressed(waveEvent, "PageUp")) {
                setFocusIndex((idx) => Math.max(idx - PageJumpSize, 0));
                return true;
            }
            if (checkKeyPressed(waveEvent, "PageDown")) {
                setFocusIndex((idx) => Math.min(idx + PageJumpSize, filteredData.length - 1));
                return true;
            }
            if (checkKeyPressed(waveEvent, "Enter")) {
                if (filteredData.length == 0) {
                    return;
                }
                model.goHistory(selectedPath);
                setSearchText("");
                globalStore.set(model.directorySearchActive, false);
                return true;
            }
            if (checkKeyPressed(waveEvent, "Backspace")) {
                if (searchText.length == 0) {
                    return true;
                }
                setSearchText((current) => current.slice(0, -1));
                return true;
            }
            if (
                checkKeyPressed(waveEvent, "Space") &&
                searchText == "" &&
                PLATFORM == PlatformMacOS &&
                !blockData?.meta?.connection
            ) {
                env.electron.onQuicklook(selectedPath);
                return true;
            }
            if (isCharacterKeyEvent(waveEvent)) {
                setSearchText((current) => current + waveEvent.key);
                return true;
            }
            return false;
        };
        return () => {
            model.directoryKeyDownHandler = null;
        };
    }, [filteredData, selectedPath, searchText, selection]);

    useEffect(() => {
        setSelection((cur) =>
            pruneSelection(
                cur,
                filteredData.map((f) => f.path)
            )
        );
    }, [filteredData]);

    useEffect(() => {
        if (filteredData.length != 0 && focusIndex > filteredData.length - 1) {
            setFocusIndex(filteredData.length - 1);
        }
    }, [filteredData]);

    const entryManagerPropsAtom = useState(
        atom<EntryManagerOverlayProps>(null) as PrimitiveAtom<EntryManagerOverlayProps>
    )[0];
    const [entryManagerProps, setEntryManagerProps] = useAtom(entryManagerPropsAtom);

    useEffect(() => {
        setSearchText("");
        setFocusIndex(0);
        setSelection(emptySelection());
        setSelectedPath("");
        setEntryManagerProps(undefined);
        setDropHint(null);
        globalStore.set(model.directorySearchActive, false);
    }, [conn, dirPath, model.directorySearchActive, setEntryManagerProps]);

    const { refs, floatingStyles, context } = useFloating({
        open: !!entryManagerProps,
        onOpenChange: () => setEntryManagerProps(undefined),
        middleware: [offset(({ rects }) => -rects.reference.height / 2 - rects.floating.height / 2)],
    });

    const handleDropCopy = useCallback(
        async (data: CommandFileCopyData, isDir: boolean) => {
            try {
                await env.rpc.FileCopyCommand(TabRpcClient, data, { timeout: data.opts.timeout });
            } catch (e) {
                console.warn("Copy failed:", e);
                const copyError = `${e}`;
                const allowRetry = copyError.includes(overwriteError) || copyError.includes(mergeError);
                let errorMsg: ErrorMsg;
                if (allowRetry) {
                    errorMsg = {
                        status: "Confirm Overwrite File(s)",
                        text: "This copy operation will overwrite an existing file. Would you like to continue?",
                        level: "warning",
                        buttons: [
                            {
                                text: "Delete Then Copy",
                                onClick: async () => {
                                    data.opts.overwrite = true;
                                    await handleDropCopy(data, isDir);
                                },
                            },
                            {
                                text: "Sync",
                                onClick: async () => {
                                    data.opts.merge = true;
                                    await handleDropCopy(data, isDir);
                                },
                            },
                        ],
                    };
                } else {
                    errorMsg = {
                        status: "Copy Failed",
                        text: copyError,
                        level: "error",
                    };
                }
                setErrorMsg(errorMsg);
            }
            model.refreshCallback();
        },
        [model.refreshCallback]
    );

    const handleDropTransfer = useCallback(
        async (data: CommandFileCopyData, mode: DropMode) => {
            const copyId = uuidv7();
            data.copyid = copyId;
            const srcName = data.srcuri?.split(/[/\\]/).pop() || "file";
            setCopyProgress({ name: srcName, bytes: 0, total: 0 });
            const unsub = waveEventSubscribeSingle({
                eventType: "filecopy:progress",
                scope: copyId,
                handler: (e) => {
                    if (e.data != null) {
                        setCopyProgress({ name: srcName, bytes: e.data.bytes, total: e.data.total });
                    }
                },
            });
            try {
                if (mode === "move") {
                    try {
                        await env.rpc.FileMoveCommand(TabRpcClient, data, { timeout: data.opts.timeout });
                    } catch (e) {
                        setErrorMsg({ status: "Move Failed", text: `${e}`, level: "error" });
                    }
                    model.refreshCallback();
                    return;
                }
                await handleDropCopy(data, false);
            } finally {
                unsub();
                setCopyProgress(null);
            }
        },
        [handleDropCopy, model.refreshCallback, env.rpc]
    );

    // folder rows and tree nodes run their drops through this same path so the progress
    // overlay and error handling stay in one place
    useEffect(() => {
        model.folderTransferCallback = async (srcuri: string, destDir: string, mode: DropMode) => {
            const desturi = await model.formatRemoteUri(destDir, globalStore.get);
            const data: CommandFileCopyData = {
                srcuri,
                desturi,
                opts: { timeout: 31536000000 },
            };
            await handleDropTransfer(data, mode);
        };
        return () => {
            model.folderTransferCallback = null;
        };
    }, [model, handleDropTransfer]);

    const [{ isOver, canDrop }, drop] = useDrop(
        () => ({
            accept: ["FILE_ITEM", NativeTypes.URL, NativeTypes.FILE], //a name of file drop type
            canDrop: (_, monitor) => {
                if (!monitor.isOver({ shallow: false })) {
                    return false;
                }
                const dragItem = monitor.getItem<DraggedFile>();
                // local FILE_ITEM: skip when this dir is already the item's parent
                // requires absolute path
                if (dragItem?.absParent != null) {
                    return dragItem.absParent !== dirPath;
                }
                // native / cross-window drag (no local item): always allow
                return true;
            },
            drop: async (draggedFile: DraggedFile, monitor) => {
                if (monitor.didDrop()) {
                    return;
                }
                // OS files dragged in from Finder/Explorer (native FILE) -> copy each into this directory.
                // react-dnd's native FILE item exposes File objects, not paths; resolve paths via the electron bridge.
                if (monitor.getItemType() === NativeTypes.FILE) {
                    const droppedFiles: File[] = (monitor.getItem() as { files?: File[] })?.files ?? [];
                    const osPaths = droppedFiles.map((f) => getApi().getPathForFile(f)).filter(Boolean);
                    if (osPaths.length === 0) {
                        return;
                    }
                    const desturi = await model.formatRemoteUri(dirPath, globalStore.get);
                    for (const osPath of osPaths) {
                        const data: CommandFileCopyData = {
                            srcuri: formatRemoteUri(osPath, null),
                            desturi,
                            opts: { timeout: 31536000000 },
                        };
                        await handleDropTransfer(data, "copy");
                    }
                    return;
                }
                // resolve the source uri before any await so the broker read (file-drag-get) is
                // dispatched at drop-entry, before the source window's dragend clears currentDrag
                let srcuris = draggedFile?.uris?.length > 0 ? draggedFile.uris : null;
                if (srcuris == null && draggedFile?.uri != null) {
                    srcuris = [draggedFile.uri];
                }
                if (srcuris == null) {
                    const brokered = await getApi().fileDragGet();
                    if (brokered == null || brokered.uris.length === 0) {
                        return;
                    }
                    srcuris = brokered.uris;
                }
                const timeoutYear = 31536000000; // one year
                const opts: FileCopyOpts = {
                    timeout: timeoutYear,
                };
                const desturi = await model.formatRemoteUri(dirPath, globalStore.get);
                for (const srcuri of srcuris) {
                    const data: CommandFileCopyData = {
                        srcuri,
                        desturi,
                        opts,
                    };
                    await handleDropTransfer(data, dropModeRef.current);
                }
            },
            collect: (monitor) => ({
                isOver: monitor.isOver({ shallow: false }),
                canDrop: monitor.canDrop(),
            }),
            // TODO: mabe add a hover option?
        }),
        [dirPath, model.formatRemoteUri, model.refreshCallback, handleDropTransfer]
    );

    useEffect(() => {
        drop(refs.reference);
    }, [refs.reference]);

    useEffect(() => {
        if (isOver && canDrop) {
            setDropHint(dropHintLabel(dropModeRef.current, dirPath));
        } else {
            setDropHint(null);
        }
    }, [isOver, canDrop, dirPath]);

    const dismiss = useDismiss(context);
    const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

    const newFile = useCallback(() => {
        setEntryManagerProps({
            entryManagerType: EntryManagerType.NewFile,
            onSave: (newName: string) => {
                console.log(`newFile: ${newName}`);
                fireAndForget(async () => {
                    await env.rpc.FileCreateCommand(
                        TabRpcClient,
                        {
                            info: {
                                path: await model.formatRemoteUri(`${dirPath}/${newName}`, globalStore.get),
                            },
                        },
                        null
                    );
                    model.refreshCallback();
                });
                setEntryManagerProps(undefined);
            },
        });
    }, [dirPath]);
    const newDirectory = useCallback(() => {
        setEntryManagerProps({
            entryManagerType: EntryManagerType.NewDirectory,
            onSave: (newName: string) => {
                console.log(`newDirectory: ${newName}`);
                fireAndForget(async () => {
                    await env.rpc.FileMkdirCommand(TabRpcClient, {
                        info: {
                            path: await model.formatRemoteUri(`${dirPath}/${newName}`, globalStore.get),
                        },
                    });
                    model.refreshCallback();
                });
                setEntryManagerProps(undefined);
            },
        });
    }, [dirPath]);

    const handleFileContextMenu = useCallback(
        (e: any) => {
            e.preventDefault();
            e.stopPropagation();
            const menu: ContextMenuItem[] = [
                {
                    label: "New File",
                    click: () => {
                        newFile();
                    },
                },
                {
                    label: "New Folder",
                    click: () => {
                        newDirectory();
                    },
                },
                {
                    type: "separator",
                },
            ];
            addOpenMenuItems(menu, conn, finfo);

            ContextMenuModel.getInstance().showContextMenu(menu, e);
        },
        [setRefreshVersion, conn, newFile, newDirectory, dirPath]
    );

    return (
        <Fragment>
            <div className={clsx("dir-preview-root", { "dir-preview-treemode": treeView })}>
                {treeView && (
                    <div className="dir-tree-sidebar">
                        <DirectoryTree model={model} />
                    </div>
                )}
                <div
                    ref={refs.setReference}
                    className={clsx("dir-table-container", "relative", "dir-preview-main", {
                        "outline outline-accent": isOver && canDrop,
                    })}
                    onChangeCapture={(e) => {
                        const event = e as React.ChangeEvent<HTMLInputElement>;
                        if (!entryManagerProps) {
                            setSearchText(event.target.value.toLowerCase());
                        }
                    }}
                    {...getReferenceProps()}
                    onContextMenu={(e) => handleFileContextMenu(e)}
                    onClick={() => setEntryManagerProps(undefined)}
                >
                    <DirectoryTable
                        model={model}
                        data={filteredData}
                        search={searchText}
                        selection={selection}
                        setSelection={setSelection}
                        focusIndex={focusIndex}
                        setFocusIndex={setFocusIndex}
                        setSearch={setSearchText}
                        setSelectedPath={setSelectedPath}
                        setRefreshVersion={setRefreshVersion}
                        entryManagerOverlayPropsAtom={entryManagerPropsAtom}
                        newFile={newFile}
                        newDirectory={newDirectory}
                    />
                    {dropHint != null && copyProgress == null && (
                        <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-accent/10 border-2 border-accent rounded z-10">
                            <span className="bg-accent/80 text-primary rounded px-2 py-1 text-sm">{dropHint}</span>
                        </div>
                    )}
                    {copyProgress != null && (
                        <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-black/30 z-10">
                            <div className="bg-accent/90 text-primary rounded px-3 py-2 text-sm flex flex-col gap-1 min-w-[200px] max-w-[80%]">
                                <div className="truncate">Copying {copyProgress.name}…</div>
                                <div>
                                    {copyProgress.total > 0
                                        ? `${Math.round((copyProgress.bytes / copyProgress.total) * 100)}% · ${(copyProgress.bytes / 1048576).toFixed(1)} / ${(copyProgress.total / 1048576).toFixed(1)} MB`
                                        : `${(copyProgress.bytes / 1048576).toFixed(1)} MB`}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
            {entryManagerProps && (
                <EntryManagerOverlay
                    {...entryManagerProps}
                    forwardRef={refs.setFloating}
                    style={floatingStyles}
                    getReferenceProps={getFloatingProps}
                    onCancel={() => setEntryManagerProps(undefined)}
                />
            )}
        </Fragment>
    );
}

export { DirectoryPreview };
