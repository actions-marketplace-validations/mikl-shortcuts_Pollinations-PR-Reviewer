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
  severity: "critical" | "warning" | "suggestion";
}

export interface ReviewResult {
  body: string;
  verdict: Verdict;
  inlineComments: InlineComment[];
}

const SYSTEM_PROMPT = `You are a senior software engineer performing a focused code review on a GitHub Pull Request.

CRITICAL RULES:
1. Only comment on REAL issues — bugs, security problems, logic errors, or significant improvements
2. DO NOT comment on style, formatting, or minor naming unless it causes confusion
3. DO NOT repeat the same issue multiple times — mention it ONCE with all affected locations
4. Maximum 5-7 inline code references total across the entire review
5. If code looks fine, say so briefly and move on — do not invent problems

You will receive the project directory structure for architectural context.

What to look for:
- Bugs and logic errors that will cause incorrect behavior
- Security vulnerabilities (injection, auth bypass, data exposure)
- Unhandled edge cases that will crash or corrupt data
- Performance issues that will noticeably impact users
- Missing error handling that will cause silent failures

What to IGNORE:
- Style preferences and formatting
- Minor naming suggestions
- "Consider using X instead of Y" unless there's a real benefit
- Theoretical issues that are unlikely in practice

INLINE REFERENCE FORMAT:
When you find a specific issue worth commenting on, use EXACTLY this format:
>>> file.ts:42 | Your comment here explaining the issue and suggested fix

Rules for inline references:
- Use >>> only for issues that NEED a comment on that specific line
- Maximum 5-7 >>> references in the entire review
- One >>> per issue — if same issue affects multiple lines, list them in one reference
- Do not use >>> for general observations or praise
- The comment after | should be concise (1-2 sentences max)

REVIEW STRUCTURE (omit empty sections):

### 🚨 Critical Issues
Bugs, security vulnerabilities, data loss risks. Use >>> for specific lines.

### ⚠️ Warnings  
Edge cases, error handling gaps, risky patterns. Use >>> sparingly.

### 💡 Suggestions
Improvements worth considering. Use >>> only if pointing to specific code.

### ✅ Summary
One sentence: what's good, what needs attention.

VERDICT (required, pick exactly one):
- ✅ **Verdict: Looks Good** — no blocking issues
- ⚠️ **Verdict: Needs Attention** — minor issues to consider
- 🚨 **Verdict: Needs Changes** — must fix before merging

Be concise. Be useful. Don't waste the developer's time.`;

const FILE_REVIEW_PROMPT = `You are a senior software engineer reviewing code changes.

RULES:
- Only flag REAL issues — bugs, security, logic errors
- Maximum 3 inline references per file chunk
- If code is fine, respond with exactly: "No issues found."
- Do not comment on style or formatting

INLINE FORMAT (use sparingly):
>>> filename.ts:42 | Brief explanation of the issue

Keep it short. One issue = one >>> reference.`;

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
    .map((f) => `- \`${f.filename}\` (${f.status}, +${f.additions}/-${f.deletions})`)
    .join("\n");
}

function buildSystemPrompt(customPrompt: string): string {
  let prompt = SYSTEM_PROMPT;
  if (customPrompt.trim()) {
    prompt += `\n\nProject context:\n${customPrompt.trim()}`;
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
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 15); i--) {
    const line = lines[i].toLowerCase();
    if (line.includes("verdict")) {
      if (line.includes("looks good")) return "APPROVE";
      if (line.includes("needs changes")) return "REQUEST_CHANGES";
      if (line.includes("needs attention")) return "COMMENT";
    }
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

      if (line.startsWith("+") && !line.startsWith("+++")) {
        validLines.add(currentLine);
        currentLine++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        continue;
      } else {
        currentLine++;
      }
    }

    map.set(file.filename, validLines);
  }

  return map;
}

function findNearestValidLine(validLines: Set<number>, target: number): number | null {
  if (validLines.size === 0) return null;
  if (validLines.has(target)) return target;

  let closest = -1;
  let minDist = Infinity;

  for (const line of validLines) {
    const dist = Math.abs(line - target);
    if (dist < minDist && dist <= 10) {
      minDist = dist;
      closest = line;
    }
  }

  return closest > 0 ? closest : null;
}

export function extractInlineComments(review: string, files: FileInfo[]): InlineComment[] {
  const comments: InlineComment[] = [];
  const validFiles = new Set(files.map((f) => f.filename));
  const diffLineMap = parseDiffLineMap(files);

  const refRegex = />>>\s*([^:\s]+):(\d+)\s*\|\s*(.+)/g;
  let match;

  while ((match = refRegex.exec(review)) !== null) {
    let filename = match[1].trim();
    const line = parseInt(match[2], 10);
    const message = match[3].trim();

    if (!message || message.length < 5) continue;

    if (!validFiles.has(filename)) {
      const found = [...validFiles].find(
        (f) => f.endsWith("/" + filename) || f.endsWith(filename)
      );
      if (found) {
        filename = found;
      } else {
        continue;
      }
    }

    const validLines = diffLineMap.get(filename);
    if (!validLines || validLines.size === 0) continue;

    const validLine = findNearestValidLine(validLines, line);
    if (!validLine) continue;

    const linesBefore = review.substring(Math.max(0, match.index - 300), match.index);
    let severity: "critical" | "warning" | "suggestion" = "suggestion";
    if (linesBefore.includes("🚨") || linesBefore.toLowerCase().includes("critical")) {
      severity = "critical";
    } else if (linesBefore.includes("⚠️") || linesBefore.toLowerCase().includes("warning")) {
      severity = "warning";
    }

    comments.push({
      path: filename,
      line: validLine,
      side: "RIGHT",
      body: message,
      severity,
    });
  }

  const seen = new Map<string, InlineComment>();
  for (const c of comments) {
    const fileKey = c.path;
    const msgNorm = c.body.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 50);
    const key = `${fileKey}:${msgNorm}`;

    const existing = seen.get(key);
    if (!existing || c.severity === "critical") {
      seen.set(key, c);
    }
  }

  const deduplicated = [...seen.values()];

  const sorted = deduplicated.sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, suggestion: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });

  return sorted.slice(0, 10);
}

function cleanReviewBody(review: string): string {
  let cleaned = review.replace(/>>>\s*[^:\s]+:\d+\s*\|\s*.+/g, "").trim();
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned;
}

function formatHeader(modelDisplay: string, filesCount: number, truncated: boolean): string {
  let header = `## 🤖 AI Code Review\n\n`;
  header += `> Reviewed **${filesCount}** file${filesCount !== 1 ? "s" : ""}`;
  if (truncated) header += ` (diff truncated)`;
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

  const userMessage = `Review this Pull Request.

**Title:** ${input.title}

**Description:**
${input.body || "_No description._"}

${structureBlock}**Files (${input.files.length}):**
${fileSummary}

**Diff:**
\`\`\`diff
${diff}
\`\`\`${truncated ? "\n\n⚠️ Diff truncated." : ""}`;

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
  const cleanedReview = cleanReviewBody(review);
  const header = formatHeader(modelDisplay, input.files.length, truncated);
  const footer = formatFooter(modelDisplay);

  return {
    body: header + cleanedReview + footer,
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

  core.info(`Split review: ${chunks.length} chunk(s)`);

  const options: PollinationsOptions = {
    apiKey: input.apiKey,
    model: input.model,
    temperature: input.temperature,
  };

  const chunkResults: string[] = [];
  let allInlineComments: InlineComment[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    core.info(`Chunk ${i + 1}/${chunks.length}: ${chunk.map((f) => f.filename).join(", ")}`);

    const { diff } = buildFullDiff(chunk, perFileLimit);

    const userMessage = `Review these files from PR "${input.title}":

${structureBlock}${chunk.map((f) => `- \`${f.filename}\``).join("\n")}

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

    const isClean = result.toLowerCase().includes("no issues found") && result.length < 50;

    if (!isClean) {
      chunkResults.push(result);
      allInlineComments = allInlineComments.concat(extractInlineComments(result, chunk));
    }
  }

  if (chunkResults.length === 0) {
    const header = formatHeader(modelDisplay, input.files.length, false);
    const footer = formatFooter(modelDisplay);
    return {
      body: header + "### ✅ Summary\nCode looks good. No issues found.\n\n✅ **Verdict: Looks Good**" + footer,
      verdict: "APPROVE",
      inlineComments: [],
    };
  }

  const mergePrompt = `Synthesize these findings into one review for PR "${input.title}":

${chunkResults.join("\n\n---\n\n")}

Rules:
- Deduplicate similar issues
- Keep only the most important findings
- Maximum 5 >>> inline references total
- Use the standard review structure

Verdict required at the end.`;

  const merged = await chatWithRetry(
    [
      { role: "system", content: buildSystemPrompt(input.customPrompt) },
      { role: "user", content: mergePrompt },
    ],
    options,
    input.maxRetries
  );

  const mergedInlineComments = extractInlineComments(merged, input.files);
  const finalComments = mergedInlineComments.length > 0 ? mergedInlineComments : allInlineComments;

  const verdict = extractVerdict(merged);
  const cleanedReview = cleanReviewBody(merged);
  const header = formatHeader(modelDisplay, input.files.length, false);
  const footer = formatFooter(modelDisplay);

  return {
    body: header + cleanedReview + footer,
    verdict,
    inlineComments: finalComments.slice(0, 10),
  };
}

export async function fetchModelDisplayName(model: string): Promise<string> {
  try {
    const response = await fetch("https://gen.pollinations.ai/text/models", {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return model;

    const models = (await response.json()) as Array<{ name: string; description?: string }>;
    const found = models.find((m) => m.name.toLowerCase() === model.toLowerCase());

    if (found?.description) {
      return found.description.split(" - ")[0].trim();
    }

    return model;
  } catch {
    return model;
  }
}

export async function reviewPR(input: ReviewInput): Promise<ReviewResult> {
  const modelDisplay = await fetchModelDisplayName(input.model);
  core.info(`Model: ${modelDisplay}`);

  const shouldSplit = input.splitReview && input.files.length > input.splitThreshold;

  if (shouldSplit) {
    core.info(`Using split review (${input.files.length} files > ${input.splitThreshold})`);
    return reviewSplit(input, modelDisplay);
  }

  return reviewSinglePass(input, modelDisplay);
}