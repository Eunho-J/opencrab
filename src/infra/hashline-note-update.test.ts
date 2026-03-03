import { describe, expect, it } from "vitest";
import {
  buildHashlineAnchors,
  readHashlineSection,
  upsertHashlineSection,
} from "./hashline-note-update.js";

describe("hashline-note-update", () => {
  it("replaces section content when hashline anchors already exist", () => {
    const key = "supervisor-checks";
    const { start, end } = buildHashlineAnchors(key);
    const original = `# Issue\n\n## Notes\n\n${start}\nold value\n${end}\n`;

    const next = upsertHashlineSection({
      content: original,
      sectionKey: key,
      sectionContent: "new value",
      insertAfter: "## Notes",
    });

    expect(next).toContain(`${start}\nnew value\n${end}`);
    expect(next).not.toContain("old value");
    expect(readHashlineSection({ content: next, sectionKey: key })).toBe("new value");
  });

  it("inserts an anchored section after a stable heading when markers are missing", () => {
    const key = "supervisor-checks";
    const { start, end } = buildHashlineAnchors(key);
    const original = "# Issue\n\n## Notes\n- existing\n";

    const next = upsertHashlineSection({
      content: original,
      sectionKey: key,
      sectionContent: "new value",
      insertAfter: "## Notes",
    });

    expect(next).toContain(`${start}\nnew value\n${end}`);
    expect(next.indexOf(start)).toBeGreaterThan(next.indexOf("## Notes"));
    expect(next.indexOf(start)).toBeLessThan(next.indexOf("- existing"));
  });

  it("appends anchored section safely when insertion anchor is missing", () => {
    const key = "supervisor-checks";
    const { start, end } = buildHashlineAnchors(key);
    const original = "# Issue\n\nNo heading here\n";

    const next = upsertHashlineSection({
      content: original,
      sectionKey: key,
      sectionContent: "new value",
      insertAfter: "## Notes",
    });

    expect(next.endsWith(`${start}\nnew value\n${end}\n`)).toBe(true);
    expect(next).toContain("No heading here");
  });
});
