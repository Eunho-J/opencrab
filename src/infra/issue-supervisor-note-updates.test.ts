import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readHashlineSection } from "./hashline-note-update.js";
import {
  appendIssueSupervisorNoteEntry,
  appendIssueSupervisorNoteEntryToFile,
  ISSUE_SUPERVISOR_SECTION_KEY,
} from "./issue-supervisor-note-updates.js";

describe("issue-supervisor-note-updates", () => {
  it("adds supervisor entry into a hashline-anchored section", () => {
    const original = "# Issue #9\n\n## Notes\n- existing\n";
    const entry = "[2026-03-03 19:51 KST] supervisor check\n- status: active";

    const next = appendIssueSupervisorNoteEntry({ content: original, entry });

    const section = readHashlineSection({
      content: next,
      sectionKey: ISSUE_SUPERVISOR_SECTION_KEY,
    });
    expect(section).toContain(entry);
  });

  it("keeps repeated supervisor entries idempotent", () => {
    const original = "# Issue #9\n\n## Notes\n";
    const entry = "[2026-03-03 19:51 KST] supervisor check\n- status: active";

    const once = appendIssueSupervisorNoteEntry({ content: original, entry });
    const twice = appendIssueSupervisorNoteEntry({ content: once, entry });

    expect(twice).toBe(once);
  });

  it("creates note file on first write and appends future entries safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-supervisor-note-"));
    const notePath = join(root, "state", "issue-notes", "issue-9.supervisor.md");

    const first = await appendIssueSupervisorNoteEntryToFile({
      notePath,
      entry: "[2026-03-03 19:51 KST] supervisor check\n- status: active",
    });
    expect(first.updated).toBe(true);

    const second = await appendIssueSupervisorNoteEntryToFile({
      notePath,
      entry: "[2026-03-03 19:56 KST] supervisor check\n- status: progressing",
    });
    expect(second.updated).toBe(true);

    const persisted = await readFile(notePath, "utf8");
    const section = readHashlineSection({
      content: persisted,
      sectionKey: ISSUE_SUPERVISOR_SECTION_KEY,
    });
    expect(section).toContain("status: active");
    expect(section).toContain("status: progressing");
  });
});
