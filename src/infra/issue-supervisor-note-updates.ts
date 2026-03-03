import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readHashlineSection, upsertHashlineSection } from "./hashline-note-update.js";

const NOTE_INSERT_ANCHOR = "## Notes";
export const ISSUE_SUPERVISOR_SECTION_KEY = "issue-supervisor-notes";

function normalizeEntry(entry: string): string {
  return entry.replace(/\r\n/g, "\n").trim();
}

export function appendIssueSupervisorNoteEntry(params: { content: string; entry: string }): string {
  const entry = normalizeEntry(params.entry);
  if (!entry) {
    return params.content;
  }

  const existing = readHashlineSection({
    content: params.content,
    sectionKey: ISSUE_SUPERVISOR_SECTION_KEY,
  });
  const existingBody = existing?.trim() ?? "";

  const nextBody = existingBody.includes(entry)
    ? existingBody
    : existingBody
      ? `${existingBody}\n\n${entry}`
      : entry;

  return upsertHashlineSection({
    content: params.content,
    sectionKey: ISSUE_SUPERVISOR_SECTION_KEY,
    sectionContent: nextBody,
    insertAfter: NOTE_INSERT_ANCHOR,
  });
}

function defaultIssueSupervisorNote(): string {
  return "# Issue Supervisor Notes\n\n## Notes\n";
}

export async function appendIssueSupervisorNoteEntryToFile(params: {
  notePath: string;
  entry: string;
}): Promise<{ updated: boolean; content: string }> {
  let content = defaultIssueSupervisorNote();

  try {
    content = await readFile(params.notePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const next = appendIssueSupervisorNoteEntry({ content, entry: params.entry });
  if (next === content) {
    return { updated: false, content };
  }

  await mkdir(dirname(params.notePath), { recursive: true });
  await writeFile(params.notePath, next, "utf8");
  return { updated: true, content: next };
}
