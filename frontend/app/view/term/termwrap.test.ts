// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("TermWrap IME data ordering", () => {
    let originalDocument: Document;

    beforeEach(() => {
        vi.useFakeTimers();
        originalDocument = globalThis.document;
        vi.stubGlobal("document", {
            createElement: () => ({
                getContext: () => null,
            }),
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        if (originalDocument != null) {
            vi.stubGlobal("document", originalDocument);
        }
        vi.resetModules();
    });

    async function makeTermWrapHarness() {
        const { TermWrap } = await import("./termwrap");
        const sent: string[] = [];
        const termWrap = Object.create(TermWrap.prototype) as InstanceType<typeof TermWrap>;

        termWrap.loaded = true;
        termWrap.disposed = false;
        termWrap.compositionActive = false;
        termWrap.compositionRecentlyEndedUntil = 0;
        termWrap.pendingCompositionSuffix = null;
        termWrap.sendDataHandler = (data: string) => sent.push(data);
        termWrap.multiInputCallback = null;

        return { sent, termWrap };
    }

    it("sends Enter after committed IME text when Enter arrives during composition", async () => {
        const { sent, termWrap } = await makeTermWrapHarness();

        termWrap.compositionActive = true;
        termWrap.handleTermData("\r");
        expect(sent).toEqual([]);

        termWrap.compositionActive = false;
        termWrap.compositionRecentlyEndedUntil = Date.now() + 75;
        termWrap.handleTermData("가");

        expect(sent).toEqual(["가", "\r"]);
    });

    it("flushes a deferred Enter if composition ends without committed text", async () => {
        const { sent, termWrap } = await makeTermWrapHarness();

        termWrap.compositionActive = true;
        termWrap.handleTermData("\r");
        termWrap.compositionActive = false;
        termWrap.schedulePendingCompositionSuffixFlush();

        vi.advanceTimersByTime(30);

        expect(sent).toEqual(["\r"]);
    });

    it("does not defer ordinary ASCII data while composition is active", async () => {
        const { sent, termWrap } = await makeTermWrapHarness();

        termWrap.compositionActive = true;
        termWrap.handleTermData("hello");

        expect(sent).toEqual(["hello"]);
    });

    it("does not treat a full ASCII line as a composition suffix", async () => {
        const { sent, termWrap } = await makeTermWrapHarness();

        termWrap.compositionRecentlyEndedUntil = Date.now() + 75;
        termWrap.handleTermData("previous sentence");

        expect(sent).toEqual(["previous sentence"]);
    });

    // Windows 229/Process ordering: the terminator overtakes the syllable and the late
    // syllable chunk (re-read from the textarea) already contains the terminator.
    it("reorders a held terminator behind the syllable and drops the duplicate", async () => {
        const { sent, termWrap } = await makeTermWrapHarness();

        termWrap.compositionRecentlyEndedUntil = Date.now() + 75;
        termWrap.handleTermData(" ");
        expect(sent).toEqual([]);

        termWrap.handleTermData("고 ");
        expect(sent).toEqual(["고 "]);
    });

    it("reorders a held terminator behind a syllable chunk that does not contain it", async () => {
        const { sent, termWrap } = await makeTermWrapHarness();

        termWrap.compositionRecentlyEndedUntil = Date.now() + 75;
        termWrap.handleTermData("?");
        termWrap.handleTermData("다");

        expect(sent).toEqual(["다", "?"]);
    });

    it("flushes a held terminator on the timer when no syllable follows", async () => {
        const { sent, termWrap } = await makeTermWrapHarness();

        termWrap.compositionRecentlyEndedUntil = Date.now() + 75;
        termWrap.handleTermData(" ");
        expect(sent).toEqual([]);

        vi.advanceTimersByTime(30);
        expect(sent).toEqual([" "]);
    });

    it("caps the held buffer instead of accumulating a whole line", async () => {
        const { sent, termWrap } = await makeTermWrapHarness();

        termWrap.compositionRecentlyEndedUntil = Date.now() + 5000;
        termWrap.handleTermData("ab");
        termWrap.handleTermData("cd");
        expect(sent).toEqual([]);

        termWrap.handleTermData("ef");
        expect(sent).toEqual(["abcd"]);
    });
});

describe("TermWrap IME keydown deferral", () => {
    let originalDocument: Document;

    beforeEach(() => {
        originalDocument = globalThis.document;
        vi.stubGlobal("document", {
            createElement: () => ({
                getContext: () => null,
            }),
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        if (originalDocument != null) {
            vi.stubGlobal("document", originalDocument);
        }
        vi.resetModules();
    });

    async function makeKeydownHarness() {
        const { TermWrap } = await import("./termwrap");
        const termWrap = Object.create(TermWrap.prototype) as InstanceType<typeof TermWrap>;
        termWrap.compositionActive = false;
        termWrap.compositionRecentlyEndedUntil = 0;
        return termWrap;
    }

    function key(k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
        return { key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods } as KeyboardEvent;
    }

    // Regression for the 받침-less Enter bug: Wave used to claim Enter, which made xterm
    // return early and skip _finalizeComposition, so the syllable landed after the newline.
    it("defers Enter to xterm while a composition is active", async () => {
        const termWrap = await makeKeydownHarness();
        termWrap.compositionActive = true;
        expect(termWrap.shouldBypassWaveKeydownForComposition(key("Enter"))).toBe(true);
    });

    it("defers Enter to xterm in the window just after compositionend", async () => {
        const termWrap = await makeKeydownHarness();
        termWrap.compositionActive = false;
        termWrap.compositionRecentlyEndedUntil = Date.now() + 75;
        expect(termWrap.shouldBypassWaveKeydownForComposition(key("Enter"))).toBe(true);
    });

    it("defers any composing key, not only short ones", async () => {
        const termWrap = await makeKeydownHarness();
        termWrap.compositionActive = true;
        for (const k of ["Enter", "Backspace", "ArrowLeft", "a", "1"]) {
            expect(termWrap.shouldBypassWaveKeydownForComposition(key(k))).toBe(true);
        }
    });

    it("keeps real shortcuts for Wave even mid-composition", async () => {
        const termWrap = await makeKeydownHarness();
        termWrap.compositionActive = true;
        expect(termWrap.shouldBypassWaveKeydownForComposition(key("t", { metaKey: true }))).toBe(false);
        expect(termWrap.shouldBypassWaveKeydownForComposition(key("c", { ctrlKey: true }))).toBe(false);
        expect(termWrap.shouldBypassWaveKeydownForComposition(key("f", { altKey: true }))).toBe(false);
    });

    it("hands keys back to Wave once composition is well over", async () => {
        const termWrap = await makeKeydownHarness();
        termWrap.compositionActive = false;
        termWrap.compositionRecentlyEndedUntil = Date.now() - 1000;
        expect(termWrap.shouldBypassWaveKeydownForComposition(key("Enter"))).toBe(false);
    });

    // Regression for the Han/Eng bulk re-input bug: never hold long runs of text or any
    // Hangul. Only "\r" (while composing) and short ASCII terminators (in the post-commit
    // window, for the Windows 229/Process orderings) may be held.
    it("never defers long text or Hangul, in or out of a composition", async () => {
        const termWrap = await makeKeydownHarness();
        for (const [active, until] of [
            [true, 0],
            [false, Date.now() + 75],
            [false, 0],
        ] as [boolean, number][]) {
            termWrap.compositionActive = active;
            termWrap.compositionRecentlyEndedUntil = until;
            expect(termWrap.shouldDeferCompositionData("hello")).toBe(false);
            expect(termWrap.shouldDeferCompositionData("가")).toBe(false);
            expect(termWrap.shouldDeferCompositionData("안녕하세요")).toBe(false);
        }
    });

    // Windows MS Korean IME reports every key as 229/Process, so a terminating space or
    // punctuation can be emitted by xterm before the committed syllable's async flush.
    // Holding it briefly in the post-commit window lets handleTermData reorder it.
    it("defers short ASCII terminators only in the post-commit window", async () => {
        const termWrap = await makeKeydownHarness();
        termWrap.compositionActive = false;
        termWrap.compositionRecentlyEndedUntil = Date.now() + 75;
        expect(termWrap.shouldDeferCompositionData(" ")).toBe(true);
        expect(termWrap.shouldDeferCompositionData("?")).toBe(true);

        termWrap.compositionActive = true;
        termWrap.compositionRecentlyEndedUntil = 0;
        expect(termWrap.shouldDeferCompositionData(" ")).toBe(false);

        termWrap.compositionActive = false;
        expect(termWrap.shouldDeferCompositionData(" ")).toBe(false);
    });

    it("holds Enter while composing", async () => {
        const termWrap = await makeKeydownHarness();
        termWrap.compositionActive = true;
        expect(termWrap.shouldDeferCompositionData("\r")).toBe(true);
    });

    // The committed syllable and the Enter land ~1ms apart; a TUI that updates its input
    // state asynchronously needs that gap or it submits against pre-commit state.
    it("holds Enter in the window just after the composition commits", async () => {
        const termWrap = await makeKeydownHarness();
        termWrap.compositionActive = false;
        termWrap.compositionRecentlyEndedUntil = Date.now() + 75;
        expect(termWrap.shouldDeferCompositionData("\r")).toBe(true);
    });

    it("passes Enter straight through once the composition window has passed", async () => {
        const termWrap = await makeKeydownHarness();
        termWrap.compositionActive = false;
        termWrap.compositionRecentlyEndedUntil = Date.now() - 1000;
        expect(termWrap.shouldDeferCompositionData("\r")).toBe(false);
    });
});
