// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { configureTerminalLinkHandlers } from "./term-links";

function mouseEvent(modifiers: Partial<MouseEvent> = {}): MouseEvent {
    return {
        ctrlKey: false,
        metaKey: false,
        clientX: 10,
        clientY: 20,
        preventDefault: vi.fn(),
        ...modifiers,
    } as unknown as MouseEvent;
}

describe("terminal link handlers", () => {
    it("installs an OSC 8 link handler on the terminal options", () => {
        const options = {};
        const handlers = configureTerminalLinkHandlers(options, false, vi.fn(), vi.fn());

        expect(options).toHaveProperty("linkHandler");
        expect(handlers).toMatchObject({
            activate: expect.any(Function),
            hover: expect.any(Function),
            leave: expect.any(Function),
        });
    });

    it("opens links only with the platform modifier", () => {
        const openLink = vi.fn();
        const windowsHandlers = configureTerminalLinkHandlers({}, false, openLink, vi.fn());
        const macHandlers = configureTerminalLinkHandlers({}, true, openLink, vi.fn());

        windowsHandlers.activate(mouseEvent(), "https://example.com/plain");
        windowsHandlers.activate(mouseEvent({ metaKey: true }), "https://example.com/meta");
        windowsHandlers.activate(mouseEvent({ ctrlKey: true }), "https://example.com/ctrl");
        macHandlers.activate(mouseEvent({ ctrlKey: true }), "https://example.com/mac-ctrl");
        macHandlers.activate(mouseEvent({ metaKey: true }), "https://example.com/mac-meta");

        expect(openLink).toHaveBeenCalledTimes(2);
        expect(openLink).toHaveBeenNthCalledWith(1, "https://example.com/ctrl");
        expect(openLink).toHaveBeenNthCalledWith(2, "https://example.com/mac-meta");
    });

    it("forwards hover state and always suppresses xterm's default navigation", () => {
        const onHover = vi.fn();
        const handlers = configureTerminalLinkHandlers({}, false, vi.fn(), onHover);
        const event = mouseEvent();

        handlers.activate(event, "https://example.com");
        handlers.hover(event, "https://example.com");
        handlers.leave();

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(onHover).toHaveBeenNthCalledWith(1, "https://example.com", 10, 20);
        expect(onHover).toHaveBeenNthCalledWith(2, null, 0, 0);
    });
});
