import { createHash } from "node:crypto";

const HASHLINE_PREFIX = "<!-- opencrab-hashline:";

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function normalizeContent(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function trimOneLeadingNewline(value: string): string {
  if (value.startsWith("\r\n")) {
    return value.slice(2);
  }
  if (value.startsWith("\n")) {
    return value.slice(1);
  }
  return value;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function buildHashlineAnchors(sectionKey: string): { start: string; end: string } {
  const digest = shortHash(sectionKey);
  return {
    start: `${HASHLINE_PREFIX}${sectionKey}:${digest}:begin -->`,
    end: `${HASHLINE_PREFIX}${sectionKey}:${digest}:end -->`,
  };
}

function buildAnchoredBlock(params: { sectionKey: string; sectionContent: string }): string {
  const anchors = buildHashlineAnchors(params.sectionKey);
  const body = normalizeContent(params.sectionContent);
  return `${anchors.start}\n${body}\n${anchors.end}\n`;
}

function findInsertPoint(content: string, insertAfter: string | RegExp): number | null {
  if (typeof insertAfter === "string") {
    const index = content.indexOf(insertAfter);
    if (index < 0) {
      return null;
    }
    const endOfLine = content.indexOf("\n", index + insertAfter.length);
    return endOfLine < 0 ? content.length : endOfLine + 1;
  }

  const match = insertAfter.exec(content);
  if (!match || typeof match.index !== "number") {
    return null;
  }
  return match.index + match[0].length;
}

function insertBlock(params: {
  content: string;
  block: string;
  insertAfter?: string | RegExp;
}): string {
  const block = ensureTrailingNewline(params.block);
  const insertPoint = params.insertAfter
    ? findInsertPoint(params.content, params.insertAfter)
    : null;

  if (insertPoint === null) {
    const base = normalizeContent(params.content);
    if (!base) {
      return block;
    }
    return `${base}\n\n${block}`;
  }

  const before = params.content.slice(0, insertPoint);
  const after = params.content.slice(insertPoint);
  const beforeSpacer = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const afterSpacer = after.startsWith("\n") || after.length === 0 ? "" : "\n";
  return `${before}${beforeSpacer}${block}${afterSpacer}${after}`;
}

export function readHashlineSection(params: {
  content: string;
  sectionKey: string;
}): string | null {
  const anchors = buildHashlineAnchors(params.sectionKey);
  const pattern = new RegExp(
    `${escapeForRegExp(anchors.start)}\\n?([\\s\\S]*?)\\n?${escapeForRegExp(anchors.end)}`,
    "m",
  );
  const match = pattern.exec(params.content);
  if (!match || typeof match[1] !== "string") {
    return null;
  }
  return normalizeContent(match[1]);
}

export function upsertHashlineSection(params: {
  content: string;
  sectionKey: string;
  sectionContent: string;
  insertAfter?: string | RegExp;
}): string {
  const anchors = buildHashlineAnchors(params.sectionKey);
  const block = buildAnchoredBlock({
    sectionKey: params.sectionKey,
    sectionContent: params.sectionContent,
  });
  const startIndex = params.content.indexOf(anchors.start);
  if (startIndex < 0) {
    return insertBlock({ content: params.content, block, insertAfter: params.insertAfter });
  }

  const endIndex = params.content.indexOf(anchors.end, startIndex + anchors.start.length);
  if (endIndex < 0) {
    // Corrupted marker pair: append a fresh block rather than risking destructive edits.
    return insertBlock({ content: params.content, block, insertAfter: params.insertAfter });
  }

  const before = params.content.slice(0, startIndex);
  const after = trimOneLeadingNewline(params.content.slice(endIndex + anchors.end.length));
  return `${before}${block}${after}`;
}
