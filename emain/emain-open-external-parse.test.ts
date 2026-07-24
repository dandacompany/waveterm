import { describe, expect, it } from "vitest";
import { parseArgvForOpenItems, parseWaveUrl } from "./emain-open-external-parse";

describe("parseWaveUrl", () => {
    it("parses wave://open?path=", () => {
        expect(parseWaveUrl("wave://open?path=%2Ftmp%2Fa.md")).toEqual({ kind: "file", path: "/tmp/a.md" });
    });
    it("parses wave://open?file= alias", () => {
        expect(parseWaveUrl("wave://open?file=%2Ftmp%2Fb.png")).toEqual({ kind: "file", path: "/tmp/b.png" });
    });
    it("returns null for non-wave urls", () => {
        expect(parseWaveUrl("https://example.com")).toBeNull();
        expect(parseWaveUrl("wave://nope")).toBeNull();
    });
});

describe("parseArgvForOpenItems", () => {
    it("extracts file paths, skips exe and flags", () => {
        const argv = ["/Applications/Wave.app/Contents/MacOS/Wave", "--flag", "/tmp/a.md", "/tmp/dir"];
        expect(parseArgvForOpenItems(argv)).toEqual([
            { kind: "file", path: "/tmp/a.md" },
            { kind: "file", path: "/tmp/dir" },
        ]);
    });
    it("extracts wave:// url from argv", () => {
        const argv = ["wave", "wave://open?path=%2Ftmp%2Fa.md"];
        expect(parseArgvForOpenItems(argv)).toEqual([{ kind: "file", path: "/tmp/a.md" }]);
    });
    it("ignores '.' and empty", () => {
        expect(parseArgvForOpenItems(["wave", ".", ""])).toEqual([]);
    });
});
