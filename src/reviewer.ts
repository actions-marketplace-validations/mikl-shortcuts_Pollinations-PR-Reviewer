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

const SYSTEM_PROMPT = `You are a senior software engineer performing a focused code review.

CRITICAL RULES:
1. Only comment on REAL issues — bugs, security, logic errors
2. DO NOT comment on style, formatting, naming preferences
3. DO NOT repeat the same issue — mention once with all locations
4. Maximum 5-7 inline references total
5. If code is fine, just write a brief summary and verdict

The diff shows line numbers in format "L123 | code". Use these EXACT line numbers.

What to flag:
- Bugs causing incorrect behavior
- Security vulnerabilities
- Unhandled edge cases causing crashes
- Performance issues impacting users
- Missing error handling

What to IGNORE:
- Style/formatting
- Minor naming suggestions
- Theoretical unlikely issues

INLINE FORMAT (use sparingly, max 5-7 total):
>>> filename.ts:123 | Your comment explaining the issue

Rules:
- Use the EXACT line number shown (L123 means line 123)
- One >>> per issue
- Comment must be 1-2 sentences

STRUCTURE:
Only include sections that have actual findings. Skip empty sections entirely.
Do not write a section header if you have nothing for it.

- 🚨 Critical Issues — only if there are bugs, security issues, crashes (delete, if not needed)
- ⚠️ Warnings — only if there are real concerns (delete, if not needed)
- 💡 Suggestions — only if there are meaningful improvements (delete, if not needed)
- ✅ Summary — always include, 1-2 sentences max

Example of good review when code is clean:
"""
### ✅ Summary
Clean implementation. Error handling is solid, no security concerns.

✅ **Verdict: Looks Good**
"""

Example when there are issues:
"""
### 🚨 Critical Issues
>>> auth.ts:45 | Missing null check will crash when user is undefined

### ✅ Summary
One critical bug found in auth flow.

🚨 **Verdict: Needs Changes**
"""

VERDICT (required, pick one):
- ✅ **Verdict: Looks Good**
- ⚠️ **Verdict: Needs Attention**
- 🚨 **Verdict: Needs Changes**

Be concise. No fluff. No empty sections.`;

const FILE_REVIEW_PROMPT = `Review code changes. Line numbers shown as "L123 | code".

RULES:
- Only flag REAL issues — bugs, security, logic errors
- Max 3 inline references per chunk
- Use EXACT line numbers from diff
- If code is clean, respond with exactly: "No issues found."
- Do NOT write section headers if nothing to report

FORMAT for issues:
>>> filename.ts:123 | Brief description

Keep response minimal. No empty sections. No fluff.`;

interface NumberedDiff {
  content: string;
  lineMap: Map<string, Set<number>>;
}

function buildNumberedDiff(files: FileInfo[], maxLength: number): { diff: string; truncated: boolean; lineMap: Map<string, Set<number>> } {
  const lineMap = new Map<string, Set<number>>();
  const parts: string[] = [];

  for (const file of files) {
    if (!file.patch) continue;

    const validLines = new Set<number>();
    const lines = file.patch.split("\n");
    const numberedLines: string[] = [];
    let currentLine = 0;

    numberedLines.push(`diff --git a/${file.filename} b/${file.filename}`);

    for (const line of lines) {
      const hunkMatch = line.match(/^@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
      if (hunkMatch) {
        currentLine = parseInt(hunkMatch[2], 10);
        numberedLines.push(line);
        continue;
      }

      if (line.startsWith("+++") || line.startsWith("---")) {
        numberedLines.push(line);
        continue;
      }

      if (line.startsWith("+")) {
        validLines.add(currentLine);
        numberedLines.push(`L${currentLine.toString().padStart(4, " ")} | ${line}`);
        currentLine++;
      } else if (line.startsWith("-")) {
        numberedLines.push(`      | ${line}`);
      } else {
        numberedLines.push(`L${currentLine.toString().padStart(4, " ")} | ${line}`);
        currentLine++;
      }
    }

    lineMap.set(file.filename, validLines);
    parts.push(numberedLines.join("\n"));
  }

  let diff = parts.join("\n\n");
  let truncated = false;

  if (diff.length > maxLength) {
    const cutPoint = diff.lastIndexOf("\n", maxLength);
    diff = diff.substring(0, cutPoint > 0 ? cutPoint : maxLength);
    truncated = true;
  }

  return { diff, truncated, lineMap };
}

function buildFileSummary(files: FileInfo[]): string {
  return files.map((f) => `- \`${f.filename}\` (${f.status}, +${f.additions}/-${f.deletions})`).join("\n");
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

function findNearestValidLine(validLines: Set<number>, target: number): number | null {
  if (validLines.size === 0) return null;
  if (validLines.has(target)) return target;

  let closest = -1;
  let minDist = Infinity;

  for (const line of validLines) {
    const dist = Math.abs(line - target);
    if (dist < minDist && dist <= 5) {
      minDist = dist;
      closest = line;
    }
  }

  return closest > 0 ? closest : null;
}

export function extractInlineComments(review: string, files: FileInfo[], lineMap: Map<string, Set<number>>): InlineComment[] {
  const comments: InlineComment[] = [];
  const validFiles = new Set(files.map((f) => f.filename));

  const refRegex = />>>\s*([^:\s]+):(\d+)\s*\|\s*(.+)/g;
  let match;

  while ((match = refRegex.exec(review)) !== null) {
    let filename = match[1].trim();
    const line = parseInt(match[2], 10);
    const message = match[3].trim();

    if (!message || message.length < 5) continue;

    if (!validFiles.has(filename)) {
      const found = [...validFiles].find((f) => f.endsWith("/" + filename) || f.endsWith(filename));
      if (found) filename = found;
      else continue;
    }

    const validLines = lineMap.get(filename);
    if (!validLines || validLines.size === 0) continue;

    const validLine = findNearestValidLine(validLines, line);
    if (!validLine) continue;

    const before = review.substring(Math.max(0, match.index - 300), match.index).toLowerCase();
    let severity: "critical" | "warning" | "suggestion" = "suggestion";
    if (before.includes("🚨") || before.includes("critical")) severity = "critical";
    else if (before.includes("⚠️") || before.includes("warning")) severity = "warning";

    comments.push({ path: filename, line: validLine, side: "RIGHT", body: message, severity });
  }

  const seen = new Map<string, InlineComment>();
  for (const c of comments) {
    const key = `${c.path}:${c.body.toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 50)}`;
    if (!seen.has(key) || c.severity === "critical") seen.set(key, c);
  }

  return [...seen.values()]
    .sort((a, b) => {
      const order = { critical: 0, warning: 1, suggestion: 2 };
      return order[a.severity] - order[b.severity];
    })
    .slice(0, 10);
}

function cleanReviewBody(review: string): string {
  let cleaned = review
    .replace(/>>>\s*([^:\s]+):(\d+)\s*\|\s*(.+)/g, "- `$1:$2` — $3")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  cleaned = cleaned
    .replace(/###\s*[^\n]+\n\s*(?=###|\n*$|✅\s*\*\*|⚠️\s*\*\*|🚨\s*\*\*)/g, "")
    .trim();

  return cleaned;
}

function formatHeader(modelDisplay: string, filesCount: number, truncated: boolean): string {
  let h = `## 🤖 AI Code Review\n\n> Reviewed **${filesCount}** file${filesCount !== 1 ? "s" : ""}`;
  if (truncated) h += " (truncated)";
  return h + "\n\n";
}

function formatFooter(modelDisplay: string): string {
  return `\n\n---\n<sub>Powered by [Pollinations AI](https://pollinations.ai) • Model: \`${modelDisplay}\`</sub>`;
}

async function reviewSinglePass(input: ReviewInput, modelDisplay: string): Promise<ReviewResult> {
  const { diff, truncated, lineMap } = buildNumberedDiff(input.files, input.maxDiffLength);
  const fileSummary = buildFileSummary(input.files);
  const structureBlock = buildProjectStructureBlock(input.projectStructure);

  const userMessage = `Review this Pull Request.

**Title:** ${input.title}

**Description:**
${input.body || "_No description._"}

${structureBlock}**Files (${input.files.length}):**
${fileSummary}

**Diff (line numbers shown as L### |):**
\`\`\`diff
${diff}
\`\`\`${truncated ? "\n\n⚠️ Diff truncated." : ""}`;

  const review = await chatWithRetry(
    [
      { role: "system", content: buildSystemPrompt(input.customPrompt) },
      { role: "user", content: userMessage },
    ],
    { apiKey: input.apiKey, model: input.model, temperature: input.temperature },
    input.maxRetries
  );

  return {
    body: formatHeader(modelDisplay, input.files.length, truncated) + cleanReviewBody(review) + formatFooter(modelDisplay),
    verdict: extractVerdict(review),
    inlineComments: extractInlineComments(review, input.files, lineMap),
  };
}

function chunkFiles(files: FileInfo[], maxChunkSize: number): FileInfo[][] {
  const chunks: FileInfo[][] = [];
  let chunk: FileInfo[] = [];
  let size = 0;

  for (const file of [...files].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))) {
    const len = file.patch?.length ?? 0;
    if (chunk.length > 0 && size + len > maxChunkSize) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(file);
    size += len;
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

async function reviewSplit(input: ReviewInput, modelDisplay: string): Promise<ReviewResult> {
  const perFileLimit = Math.floor(input.maxDiffLength / 2);
  const chunks = chunkFiles(input.files, perFileLimit);
  const structureBlock = buildProjectStructureBlock(input.projectStructure);

  core.info(`Split: ${chunks.length} chunks`);

  const opts = { apiKey: input.apiKey, model: input.model, temperature: input.temperature };
  const results: string[] = [];
  let allComments: InlineComment[] = [];
  let allLineMaps = new Map<string, Set<number>>();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    core.info(`Chunk ${i + 1}/${chunks.length}`);

    const { diff, lineMap } = buildNumberedDiff(chunk, perFileLimit);
    for (const [k, v] of lineMap) allLineMaps.set(k, v);

    const msg = `Review files from PR "${input.title}":

${structureBlock}${chunk.map((f) => `- \`${f.filename}\``).join("\n")}

\`\`\`diff
${diff}
\`\`\``;

    const res = await chatWithRetry(
      [{ role: "system", content: FILE_REVIEW_PROMPT }, { role: "user", content: msg }],
      opts,
      input.maxRetries
    );

    if (!(res.toLowerCase().includes("no issues found") && res.length < 50)) {
      results.push(res);
      allComments = allComments.concat(extractInlineComments(res, chunk, lineMap));
    }
  }

  if (results.length === 0) {
    return {
      body: formatHeader(modelDisplay, input.files.length, false) + "### ✅ Summary\nNo issues found.\n\n✅ **Verdict: Looks Good**" + formatFooter(modelDisplay),
      verdict: "APPROVE",
      inlineComments: [],
    };
  }

  const merged = await chatWithRetry(
    [
      { role: "system", content: buildSystemPrompt(input.customPrompt) },
      { role: "user", content: `Synthesize findings for PR "${input.title}":\n\n${results.join("\n\n---\n\n")}\n\nDeduplicate. Max 5 >>> refs. Verdict required.` },
    ],
    opts,
    input.maxRetries
  );

  const mergedComments = extractInlineComments(merged, input.files, allLineMaps);

  return {
    body: formatHeader(modelDisplay, input.files.length, false) + cleanReviewBody(merged) + formatFooter(modelDisplay),
    verdict: extractVerdict(merged),
    inlineComments: (mergedComments.length > 0 ? mergedComments : allComments).slice(0, 10),
  };
}

export async function fetchModelDisplayName(model: string): Promise<string> {
  try {
    const res = await fetch("https://gen.pollinations.ai/text/models", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return model;
    const models = (await res.json()) as Array<{ name: string; description?: string }>;
    const found = models.find((m) => m.name.toLowerCase() === model.toLowerCase());
    return found?.description?.split(" - ")[0]?.trim() || model;
  } catch {
    return model;
  }
}

export async function reviewPR(input: ReviewInput): Promise<ReviewResult> {
  const modelDisplay = await fetchModelDisplayName(input.model);
  core.info(`Model: ${modelDisplay}`);

  if (input.splitReview && input.files.length > input.splitThreshold) {
    core.info(`Split review: ${input.files.length} files`);
    return reviewSplit(input, modelDisplay);
  }

  return reviewSinglePass(input, modelDisplay);
}