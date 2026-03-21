import * as core from "@actions/core";
import { chatWithRetry, PollinationsOptions } from "./pollinations";

export interface FileInfo {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface ReviewInput {
  title: string;
  body: string;
  files: FileInfo[];
  apiKey: string;
  model: string;
  maxDiffLength: number;
  customPrompt: string;
  temperature: number;
  maxRetries: number;
  splitReview: boolean;
  splitThreshold: number;
  projectStructure: string;
}

export type Verdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export interface ReviewResult {
  body: string;
  verdict: Verdict;
  inlineComments: InlineComment[];
}

const SYSTEM_PROMPT = `You are a principal software engineer performing a thorough code review on a GitHub Pull Request.

Your review must be:
- Precise, specific, and actionable
- Focused on real, impactful issues — never invent problems
- Constructive, professional, and concise

You will receive the full project directory structure. Use it to understand the codebase layout, detect misplaced files, missing tests, broken imports, and architectural issues.

Analyze for:
- Bugs, logic errors, off-by-one mistakes, null/undefined dereferences
- Security vulnerabilities (injection, auth bypass, secrets exposure, path traversal, SSRF)
- Performance issues (N+1 queries, unbounded allocations, blocking I/O, memory leaks)
- Error handling gaps (swallowed exceptions, missing validation, unhandled promise rejections)
- Race conditions, deadlocks, and concurrency hazards
- API contract mismatches (wrong types, missing fields, breaking changes)
- Missing edge cases (empty input, large input, Unicode, negative numbers, concurrent access)
- Resource leaks (unclosed handles, missing cleanup, event listener accumulation)
- Dependency concerns (known CVEs, unnecessary dependencies, version conflicts)
- Structural issues (files in wrong directories, missing index files, broken module boundaries)

IMPORTANT: When referencing specific code issues, ALWAYS use this exact format:
📍 \`filename.ts:42\` — description of the issue

This format is machine-parsed to create inline comments on the PR. Use the actual filename from the diff and the actual line number from the new file (right side of the diff, lines starting with +). If you cannot determine the exact line, omit the line number: 📍 \`filename.ts\` — description.

Structure your review using these sections — omit any section that has no findings:

### 🚨 Critical Issues
Bugs, security vulnerabilities, data loss risks, crashes.
Use 📍 references for each finding.

### ⚠️ Warnings
Potential problems, unhandled edge cases, risky patterns, tech debt.
Use 📍 references for each finding.

### 💡 Suggestions
Better approaches, cleaner patterns, performance improvements, readability wins.
Use 📍 references where applicable.

### 📝 Nitpicks
Minor style or naming issues. Maximum 3 items.

### ✅ What Looks Good
Briefly acknowledge well-written code, good patterns, or solid test coverage.

End with exactly one verdict line:
- ✅ **Verdict: Looks Good** — no blockers found
- ⚠️ **Verdict: Needs Attention** — non-blocking suggestions
- 🚨 **Verdict: Needs Changes** — blocking issues that must be fixed

Be brutally honest. If the code is clean, say so briefly and move on.`;

const FILE_REVIEW_PROMPT = `You are a principal software engineer reviewing files from a Pull Request.

You will receive the project directory structure for context.

Analyze the diff for bugs, security issues, performance problems, and correctness.
Be concise. Only report real findings.

IMPORTANT: When referencing issues, ALWAYS use this exact format:
📍 \`filename.ts:42\` — description of the issue

Use actual filenames and line numbers from the diff (new file side, lines with +).

If the files look fine, respond with exactly: "No issues found."

Otherwise list findings as bullet points with severity emoji:
- 🚨 for critical (bugs, security, crashes)
- ⚠️ for warnings (edge cases, risky patterns)
- 💡 for suggestions (improvements, readability)`;

function buildFileDiff(file: FileInfo): string {
  if (!file.patch) return "";
  return `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`;
}

function buildFullDiff(files: FileInfo[], maxLength: number): { diff: string; truncated: boolean } {
  let diff = files
    .filter((f) => f.patch)
    .map((f) => buildFileDiff(f))
    .join("\n\n");

  let truncated = false;
  if (diff.length > maxLength) {
    const cutPoint = diff.lastIndexOf("\n", maxLength);
    diff = diff.substring(0, cutPoint > 0 ? cutPoint : maxLength);
    truncated = true;
  }

  return { diff, truncated };
}

function buildFileSummary(files: FileInfo[]): string {
  return files
    .map(
      (f) =>
        `- \`${f.filename}\` (${f.status}, +${f.additions}/-${f.deletions})`
    )
    .join("\n");
}

function buildSystemPrompt(customPrompt: string): string {
  let prompt = SYSTEM_PROMPT;
  if (customPrompt.trim()) {
    prompt += `\n\nAdditional context from repository maintainer:\n${customPrompt.trim()}`;
  }
  return prompt;
}

function buildProjectStructureBlock(structure: string): string {
  if (!structure.trim()) return "";
  return `**Project Structure:**
\`\`\`
${structure.trim()}
\`\`\`

`;
}

export function extractVerdict(review: string): Verdict {
  const lines = review.split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const line = lines[i].toLowerCase();
    if (line.includes("verdict")) {
      if (line.includes("looks good")) return "APPROVE";
      if (line.includes("needs changes")) return "REQUEST_CHANGES";
      if (line.includes("needs attention")) return "COMMENT";
    }
  }

  const fullLower = review.toLowerCase();
  if (fullLower.includes("🚨") && fullLower.includes("critical")) {
    return "REQUEST_CHANGES";
  }

  return "COMMENT";
}

function parseDiffLineMap(files: FileInfo[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();

  for (const file of files) {
    if (!file.patch) continue;

    const lines = file.patch.split("\n");
    const validLines = new Set<number>();
    let currentLine = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@\s*-\d+(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
      if (hunkMatch) {
        currentLine = parseInt(hunkMatch[1], 10);
        continue;
      }

      if (line.startsWith("+")) {
        validLines.add(currentLine);
        currentLine++;
      } else if (line.startsWith("-")) {
        continue;
      } else {
        currentLine++;
      }
    }

    map.set(file.filename, validLines);
  }

  return map;
}

function findNearestValidLine(validLines: Set<number>, target: number): number {
  if (validLines.has(target)) return target;

  let closest = -1;
  let minDist = Infinity;

  for (const line of validLines) {
    const dist = Math.abs(line - target);
    if (dist < minDist) {
      minDist = dist;
      closest = line;
    }
  }

  return closest > 0 ? closest : target;
}

export function extractInlineComments(review: string, files: FileInfo[]): InlineComment[] {
  const comments: InlineComment[] = [];
  const validFiles = new Set(files.map((f) => f.filename));
  const diffLineMap = parseDiffLineMap(files);

  const pinRegex = /📍\s*`([^`]+?)`\s*[—–-]\s*(.+)/g;
  let match;

  while ((match = pinRegex.exec(review)) !== null) {
    const ref = match[1].trim();
    const message = match[2].trim();

    if (!message) continue;

    const fileLineMatch = ref.match(/^(.+?):(\d+)$/);

    let filename: string;
    let line: number;

    if (fileLineMatch) {
      filename = fileLineMatch[1];
      line = parseInt(fileLineMatch[2], 10);
    } else {
      filename = ref;
      line = 1;
    }

    if (!validFiles.has(filename)) {
      const found = [...validFiles].find(
        (f) => f.endsWith("/" + filename) || f === filename
      );
      if (found) {
        filename = found;
      } else {
        continue;
      }
    }

    const validLines = diffLineMap.get(filename);
    if (validLines && validLines.size > 0) {
      line = findNearestValidLine(validLines, line);
    }

    let severity = "💬";
    const linesBefore = review.substring(
      Math.max(0, match.index - 200),
      match.index
    );
    if (linesBefore.includes("🚨") || linesBefore.includes("Critical")) {
      severity = "🚨";
    } else if (linesBefore.includes("⚠️") || linesBefore.includes("Warning")) {
      severity = "⚠️";
    } else if (linesBefore.includes("💡") || linesBefore.includes("Suggestion")) {
      severity = "💡";
    }

    comments.push({
      path: filename,
      line,
      side: "RIGHT",
      body: `${severity} ${message}`,
    });
  }

  const seen = new Set<string>();
  return comments.filter((c) => {
    const key = `${c.path}:${c.line}:${c.body}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatHeader(modelDisplay: string, filesCount: number, truncated: boolean): string {
  let header = `## 🤖 AI Code Review\n\n`;
  header += `> Reviewed **${filesCount}** file${filesCount !== 1 ? "s" : ""}`;
  if (truncated) {
    header += ` (diff was truncated)`;
  }
  header += `\n\n`;
  return header;
}

function formatFooter(modelDisplay: string): string {
  return `\n\n---\n<sub>Powered by [Pollinations AI](https://pollinations.ai) • Model: \`${modelDisplay}\`</sub>`;
}

async function reviewSinglePass(input: ReviewInput, modelDisplay: string): Promise<ReviewResult> {
  const { diff, truncated } = buildFullDiff(input.files, input.maxDiffLength);
  const fileSummary = buildFileSummary(input.files);
  const systemPrompt = buildSystemPrompt(input.customPrompt);
  const structureBlock = buildProjectStructureBlock(input.projectStructure);

  let userMessage = `Review this Pull Request.

**Title:** ${input.title}

**Description:**
${input.body || "_No description provided._"}

${structureBlock}**Changed Files (${input.files.length}):**
${fileSummary}

**Diff:**
\`\`\`diff
${diff}
\`\`\``;

  if (truncated) {
    userMessage +=
      "\n\n⚠️ The diff was truncated due to size. Review what is shown above thoroughly.";
  }

  const options: PollinationsOptions = {
    apiKey: input.apiKey,
    model: input.model,
    temperature: input.temperature,
  };

  const review = await chatWithRetry(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    options,
    input.maxRetries
  );

  const verdict = extractVerdict(review);
  const inlineComments = extractInlineComments(review, input.files);
  const header = formatHeader(modelDisplay, input.files.length, truncated);
  const footer = formatFooter(modelDisplay);

  return {
    body: header + review + footer,
    verdict,
    inlineComments,
  };
}

function chunkFiles(files: FileInfo[], maxChunkSize: number): FileInfo[][] {
  const chunks: FileInfo[][] = [];
  let currentChunk: FileInfo[] = [];
  let currentSize = 0;

  const sorted = [...files].sort(
    (a, b) => (b.additions + b.deletions) - (a.additions + a.deletions)
  );

  for (const file of sorted) {
    const patchLen = file.patch?.length ?? 0;

    if (currentChunk.length > 0 && currentSize + patchLen > maxChunkSize) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }

    currentChunk.push(file);
    currentSize += patchLen;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function reviewSplit(input: ReviewInput, modelDisplay: string): Promise<ReviewResult> {
  const perFileLimit = Math.floor(input.maxDiffLength / 2);
  const chunks = chunkFiles(input.files, perFileLimit);
  const structureBlock = buildProjectStructureBlock(input.projectStructure);

  core.info(`Split review: ${chunks.length} chunk(s) from ${input.files.length} files`);

  const options: PollinationsOptions = {
    apiKey: input.apiKey,
    model: input.model,
    temperature: input.temperature,
  };

  const chunkResults: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const fileNames = chunk.map((f) => f.filename).join(", ");
    core.info(`Reviewing chunk ${i + 1}/${chunks.length}: ${fileNames}`);

    const { diff } = buildFullDiff(chunk, perFileLimit);

    const userMessage = `Review these files from a PR titled "${input.title}":

${structureBlock}${chunk.map((f) => `- \`${f.filename}\` (${f.status}, +${f.additions}/-${f.deletions})`).join("\n")}

\`\`\`diff
${diff}
\`\`\``;

    const result = await chatWithRetry(
      [
        { role: "system", content: FILE_REVIEW_PROMPT },
        { role: "user", content: userMessage },
      ],
      options,
      input.maxRetries
    );

    const isClean =
      result.toLowerCase().includes("no issues found") &&
      result.length < 100;

    if (!isClean) {
      const header = chunk.length === 1
        ? `#### \`${chunk[0].filename}\``
        : `#### ${chunk.map((f) => `\`${f.filename}\``).join(", ")}`;
      chunkResults.push(`${header}\n${result}`);
    }
  }

  if (chunkResults.length === 0) {
    const header = formatHeader(modelDisplay, input.files.length, false);
    const footer = formatFooter(modelDisplay);
    return {
      body:
        header +
        "### ✅ What Looks Good\nAll reviewed files look clean. No issues found.\n\n✅ **Verdict: Looks Good**" +
        footer,
      verdict: "APPROVE",
      inlineComments: [],
    };
  }

  const mergePrompt = `You are a principal software engineer. Below are per-file review findings from a PR titled "${input.title}".

PR Description: ${input.body || "No description provided."}

${structureBlock}File findings:
${chunkResults.join("\n\n---\n\n")}

Synthesize into a single cohesive review using this structure (omit empty sections):

### 🚨 Critical Issues
### ⚠️ Warnings
### 💡 Suggestions
### 📝 Nitpicks
### ✅ What Looks Good

IMPORTANT: Preserve all 📍 \`filename:line\` — description references from the original findings.

End with exactly one verdict line:
- ✅ **Verdict: Looks Good**
- ⚠️ **Verdict: Needs Attention**
- 🚨 **Verdict: Needs Changes**

Deduplicate findings. Be concise. Reference file names.`;

  const systemPrompt = buildSystemPrompt(input.customPrompt);

  const merged = await chatWithRetry(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: mergePrompt },
    ],
    options,
    input.maxRetries
  );

  const verdict = extractVerdict(merged);
  const inlineComments = extractInlineComments(merged, input.files);
  const header = formatHeader(modelDisplay, input.files.length, false);
  const footer = formatFooter(modelDisplay);

  return {
    body: header + merged + footer,
    verdict,
    inlineComments,
  };
}

export async function fetchModelDisplayName(model: string): Promise<string> {
  try {
    const response = await fetch("https://gen.pollinations.ai/text/models", {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return model;

    const models = (await response.json()) as Array<{
      name: string;
      description?: string;
    }>;

    const found = models.find(
      (m) => m.name.toLowerCase() === model.toLowerCase()
    );

    if (found?.description) {
      const parts = found.description.split(" - ");
      return parts[0].trim();
    }

    return model;
  } catch {
    return model;
  }
}

export async function reviewPR(input: ReviewInput): Promise<ReviewResult> {
  const modelDisplay = await fetchModelDisplayName(input.model);
  core.info(`Model display name: ${modelDisplay}`);

  const shouldSplit =
    input.splitReview && input.files.length > input.splitThreshold;

  if (shouldSplit) {
    core.info(
      `PR has ${input.files.length} files (threshold: ${input.splitThreshold}), using split review`
    );
    return reviewSplit(input, modelDisplay);
  }

  return reviewSinglePass(input, modelDisplay);
}