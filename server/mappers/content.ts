import type { ProviderContent } from "@getpaseo/plugin/server/provider";
import type { BridgeInputBlock } from "../protocol.ts";

function formatReviewAttachment(
  part: Extract<ProviderContent, { type: "review" }>,
): string {
  const header = [
    `[Code Review (${part.mode}${part.baseRef ? ` vs ${part.baseRef}` : ""}) in ${part.cwd}]`,
  ];
  for (const comment of part.comments) {
    header.push(
      `\nFile: ${comment.filePath}:${comment.lineNumber} (${comment.side})`,
      `Hunk: ${comment.context.hunkHeader}`,
      `Comment: ${comment.body}`,
    );
    if (comment.context.lines.length > 0) {
      header.push("Context:");
      for (const line of comment.context.lines) {
        const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
        header.push(`${prefix}${line.content}`);
      }
    }
  }
  return header.join("\n");
}

function formatPrOrIssue(
  kind: string,
  part: {
    number: number;
    title: string;
    url: string;
    body?: string | null;
    forge?: string;
    projectPath?: string;
    baseRefName?: string | null;
    headRefName?: string | null;
  },
): string {
  const lines = [
    `[${kind} #${part.number}: ${part.title}]`,
    `URL: ${part.url}`,
  ];
  if (part.forge) lines.push(`Forge: ${part.forge}`);
  if (part.projectPath) lines.push(`Project: ${part.projectPath}`);
  if (part.baseRefName || part.headRefName) {
    lines.push(`Branches: ${part.headRefName ?? "?"} -> ${part.baseRefName ?? "?"}`);
  }
  if (part.body) lines.push("", part.body);
  return lines.join("\n");
}

function formatTextAttachment(
  part: Extract<ProviderContent, { type: "text"; mimeType: "text/plain" }>,
): string {
  const header: string[] = [];
  if (part.title) header.push(`[Attachment: ${part.title}]`);
  else if (part.contextKind) header.push(`[Context: ${part.contextKind}]`);
  if (part.externalResource) {
    header.push(
      `Source: ${part.externalResource.providerLabel} ${part.externalResource.identifier} (${part.externalResource.url})`,
    );
  }
  header.push(part.text);
  return header.join("\n");
}

export function mapProviderContentToBridgeBlocks(
  content: readonly ProviderContent[],
  imageSupported: boolean,
): { blocks: BridgeInputBlock[]; displayText: string } {
  const blocks: BridgeInputBlock[] = [];
  const textParts: string[] = [];

  const pushText = (text: string) => {
    if (!text) return;
    blocks.push({ type: "text", text });
    textParts.push(text);
  };

  for (const part of content) {
    switch (part.type) {
      case "text":
        if ("mimeType" in part && part.mimeType === "text/plain") {
          pushText(formatTextAttachment(part));
        } else {
          pushText(part.text);
        }
        break;
      case "image":
        if (imageSupported) {
          blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
        } else {
          pushText(`[Image attachment (${part.mimeType}) omitted: active model does not support image input]`);
        }
        break;
      case "uploaded_file":
        pushText(`[Uploaded file: ${part.fileName} (${part.mimeType}, ${part.size} bytes) at ${part.path}]`);
        break;
      case "review":
        pushText(formatReviewAttachment(part));
        break;
      case "github_pr":
        pushText(formatPrOrIssue("GitHub PR", part));
        break;
      case "github_issue":
        pushText(formatPrOrIssue("GitHub Issue", part));
        break;
      case "forge_change_request":
        pushText(formatPrOrIssue("Change Request", part));
        break;
      case "forge_issue":
        pushText(formatPrOrIssue("Issue", part));
        break;
    }
  }

  return {
    blocks,
    displayText: textParts.join("\n"),
  };
}
