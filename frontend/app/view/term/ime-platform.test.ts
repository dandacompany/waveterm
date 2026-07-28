// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom

// End-to-end regression for Windows MS Korean IME event orderings: drives a real xterm
// Terminal with the event sequences Windows Chromium produces (every key reported as
// 229/Process) and pipes xterm's output through TermWrap's IME layer, asserting the
// bytes that would reach the PTY. The critical case is B: when the keyup for a
// terminating key (space/punctuation) lands before its `input` event, xterm sends the
// terminator immediately while the committed syllable is still waiting in
// _finalizeComposition's setTimeout(0), so the terminator overtakes the syllable and the
// late syllable chunk re-read from the textarea duplicates the terminator.
//
// The fix relies on the UI Events ordering guarantee that the commit `input` event follows
// compositionend, which is what lets the post-commit window catch the terminator. A
// terminator arriving *before* compositionend would not be caught, but that ordering
// violates the spec and is not handled deliberately: covering it would mean holding text
// during an active composition, which turns a missed compositionend (focus loss mid-
// composition) into permanently chunked typing rather than a merely delayed Enter.

import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TermWrap } from "./termwrap";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
    textarea: HTMLTextAreaElement;
    sent: string[];
    dispose: () => void;
}

function makeHarness(): Harness {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const term = new Terminal({ allowProposedApi: true });
    term.open(container);

    const sent: string[] = [];
    const termWrap = Object.create(TermWrap.prototype) as InstanceType<typeof TermWrap>;
    termWrap.loaded = true;
    termWrap.disposed = false;
    termWrap.compositionActive = false;
    termWrap.compositionRecentlyEndedUntil = 0;
    termWrap.pendingCompositionSuffix = null;
    termWrap.sendDataHandler = (data: string) => sent.push(data);
    termWrap.multiInputCallback = null;
    termWrap.terminal = term;
    termWrap.toDispose = [];
    termWrap.registerCompositionEventHandlers();
    term.onData((d) => termWrap.handleTermData(d));

    return {
        textarea: term.textarea!,
        sent,
        dispose: () => {
            term.dispose();
            container.remove();
        },
    };
}

function keydown(textarea: HTMLTextAreaElement, opts: { key: string; keyCode: number; isComposing?: boolean }) {
    const ev = new KeyboardEvent("keydown", { key: opts.key, bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(ev, "keyCode", { value: opts.keyCode });
    Object.defineProperty(ev, "isComposing", { value: opts.isComposing ?? false });
    textarea.dispatchEvent(ev);
}

function keypress(textarea: HTMLTextAreaElement, opts: { key: string; charCode: number }) {
    const ev = new KeyboardEvent("keypress", { key: opts.key, bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(ev, "charCode", { value: opts.charCode });
    Object.defineProperty(ev, "which", { value: opts.charCode });
    textarea.dispatchEvent(ev);
}

function keyup(textarea: HTMLTextAreaElement, opts: { key: string; keyCode: number }) {
    const ev = new KeyboardEvent("keyup", { key: opts.key, bubbles: true, composed: true });
    Object.defineProperty(ev, "keyCode", { value: opts.keyCode });
    textarea.dispatchEvent(ev);
}

function composition(textarea: HTMLTextAreaElement, type: string, data: string) {
    textarea.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, composed: true }));
}

function inputEvent(textarea: HTMLTextAreaElement, inputType: string, data: string) {
    textarea.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true, composed: true }));
}

describe("Platform Korean IME event orderings through xterm + TermWrap", () => {
    let h: Harness;

    beforeEach(() => {
        h = makeHarness();
    });

    afterEach(() => {
        h.dispose();
    });

    // Compose "고" via ㄱ+ㅗ, all keydowns reported as 229/Process.
    async function composeGo() {
        keydown(h.textarea, { key: "Process", keyCode: 229, isComposing: false });
        composition(h.textarea, "compositionstart", "");
        composition(h.textarea, "compositionupdate", "ㄱ");
        h.textarea.value = "ㄱ";
        inputEvent(h.textarea, "insertCompositionText", "ㄱ");
        await sleep(0);
        keyup(h.textarea, { key: "Process", keyCode: 229 });

        keydown(h.textarea, { key: "Process", keyCode: 229, isComposing: true });
        composition(h.textarea, "compositionupdate", "고");
        h.textarea.value = "고";
        inputEvent(h.textarea, "insertCompositionText", "고");
        await sleep(0);
        keyup(h.textarea, { key: "Process", keyCode: 229 });
    }

    it("A: space as 229, input event before keyup", async () => {
        await composeGo();
        keydown(h.textarea, { key: "Process", keyCode: 229, isComposing: true });
        composition(h.textarea, "compositionend", "고");
        h.textarea.value = "고 ";
        inputEvent(h.textarea, "insertText", " ");
        keyup(h.textarea, { key: "Process", keyCode: 229 });
        await sleep(50);
        expect(h.sent.join("")).toBe("고 ");
    });

    // The ordering that reproduces the 0.17.0 Windows report: keyup beats the input
    // event, so raw xterm emits " " then "고 " (terminator first, then duplicated).
    it("B: space as 229, keyup fires before the input event", async () => {
        await composeGo();
        keydown(h.textarea, { key: "Process", keyCode: 229, isComposing: true });
        composition(h.textarea, "compositionend", "고");
        keyup(h.textarea, { key: "Process", keyCode: 229 });
        h.textarea.value = "고 ";
        inputEvent(h.textarea, "insertText", " ");
        await sleep(50);
        expect(h.sent.join("")).toBe("고 ");
    });

    it("D: compositionend, then a real space keydown+keypress before the async flush", async () => {
        await composeGo();
        keydown(h.textarea, { key: "Process", keyCode: 229, isComposing: true });
        composition(h.textarea, "compositionend", "고");
        keydown(h.textarea, { key: " ", keyCode: 32, isComposing: false });
        keypress(h.textarea, { key: " ", charCode: 32 });
        h.textarea.value = "고 ";
        keyup(h.textarea, { key: " ", keyCode: 32 });
        await sleep(50);
        expect(h.sent.join("")).toBe("고 ");
    });

    it("E: question mark as 229, keyup fires before the input event", async () => {
        await composeGo();
        keydown(h.textarea, { key: "Process", keyCode: 229, isComposing: true });
        composition(h.textarea, "compositionend", "고");
        keyup(h.textarea, { key: "Process", keyCode: 229 });
        h.textarea.value = "고?";
        inputEvent(h.textarea, "insertText", "?");
        await sleep(50);
        expect(h.sent.join("")).toBe("고?");
    });

    it("F: next syllable starts immediately (고 committed by typing ㅇ of 있)", async () => {
        await composeGo();
        keydown(h.textarea, { key: "Process", keyCode: 229, isComposing: true });
        composition(h.textarea, "compositionend", "고");
        composition(h.textarea, "compositionstart", "");
        composition(h.textarea, "compositionupdate", "이");
        h.textarea.value = "고이";
        inputEvent(h.textarea, "insertCompositionText", "이");
        keyup(h.textarea, { key: "Process", keyCode: 229 });
        await sleep(50);
        expect(h.sent.join("")).toBe("고");
    });

    // Linux ibus/fcitx orderings. ibus intercepts keydown (reported as 229) but lets the
    // keyup through with the real keycode, and routes the commit through the IBus daemon,
    // so the terminator can land before or after compositionend.
    it("L1: ibus — keydown 229, compositionend, input, real keyup(32)", async () => {
        await composeGo();
        keydown(h.textarea, { key: "Process", keyCode: 229, isComposing: true });
        composition(h.textarea, "compositionend", "고");
        h.textarea.value = "고 ";
        inputEvent(h.textarea, "insertText", " ");
        keyup(h.textarea, { key: " ", keyCode: 32 });
        await sleep(50);
        expect(h.sent.join("")).toBe("고 ");
    });

    it("L2: ibus — real keyup(32) before the input event", async () => {
        await composeGo();
        keydown(h.textarea, { key: "Process", keyCode: 229, isComposing: true });
        composition(h.textarea, "compositionend", "고");
        keyup(h.textarea, { key: " ", keyCode: 32 });
        h.textarea.value = "고 ";
        inputEvent(h.textarea, "insertText", " ");
        await sleep(50);
        expect(h.sent.join("")).toBe("고 ");
    });

    // fcitx5 emits an empty compositionupdate to clear the preedit before committing.
    it("L3: fcitx5 — empty compositionupdate precedes compositionend", async () => {
        await composeGo();
        keydown(h.textarea, { key: "Process", keyCode: 229, isComposing: true });
        composition(h.textarea, "compositionupdate", "");
        composition(h.textarea, "compositionend", "고");
        keyup(h.textarea, { key: " ", keyCode: 32 });
        h.textarea.value = "고 ";
        inputEvent(h.textarea, "insertText", " ");
        await sleep(50);
        expect(h.sent.join("")).toBe("고 ");
    });
});
