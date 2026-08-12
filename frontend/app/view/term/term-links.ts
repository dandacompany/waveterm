// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ITerminalOptions } from "@xterm/xterm";

export type TerminalLinkHandlers = {
    activate: (event: MouseEvent, uri: string) => void;
    hover: (event: MouseEvent, uri: string) => void;
    leave: () => void;
};

export function configureTerminalLinkHandlers(
    options: Pick<ITerminalOptions, "linkHandler">,
    isMacOS: boolean,
    openUri: (uri: string) => void,
    onHover: (uri: string | null, mouseX: number, mouseY: number) => void
): TerminalLinkHandlers {
    const handlers: TerminalLinkHandlers = {
        activate: (event, uri) => {
            event.preventDefault();
            if (isMacOS ? event.metaKey : event.ctrlKey) {
                openUri(uri);
            }
        },
        hover: (event, uri) => onHover(uri, event.clientX, event.clientY),
        leave: () => onHover(null, 0, 0),
    };
    options.linkHandler = {
        activate: (event, uri) => handlers.activate(event, uri),
        hover: (event, uri) => handlers.hover(event, uri),
        leave: () => handlers.leave(),
    };
    return handlers;
}
