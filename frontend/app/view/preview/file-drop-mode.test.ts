import { describe, expect, it } from "vitest";
import { dropHintLabel, resolveDropMode } from "./file-drop-mode";

describe("resolveDropMode", () => {
    it("defaults to copy", () => {
        expect(resolveDropMode({})).toBe("copy");
    });
    it("move when metaKey (cmd)", () => {
        expect(resolveDropMode({ metaKey: true })).toBe("move");
    });
    it("move when ctrlKey", () => {
        expect(resolveDropMode({ ctrlKey: true })).toBe("move");
    });
});

describe("dropHintLabel", () => {
    it("labels copy and move", () => {
        expect(dropHintLabel("copy", "/tmp/dst")).toBe("Copy to /tmp/dst");
        expect(dropHintLabel("move", "/tmp/dst")).toBe("Move to /tmp/dst");
    });
});
