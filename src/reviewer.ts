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
}

export type Verdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface ReviewResult {
  body: string;
  verdict: Verdict;
}

const SYSTEM_PROMPT = `You are a principal software engineer performing a thorough code review on a GitHub Pull Request.

Your review must be:
- Precise, specific, and actionable with file names and line references when possible
- Focused on real, impactful issues — never invent problems or pad the review
- Constructive, professional, and concise

Analyze for:
- Bugs, logic errors, off-by-one mistakes, null/undefined dereferences
- Security vulnerabilities (injection, auth bypass, secrets exposure, path traversal, SSRF)
- Performance issues (N+1 queries, unbounded allocations, blocking I/O on hot paths, memory leaks)
- Error handling gaps (swallowed exceptions, missing validation, unhandled promise rejections)
- Race conditions, deadlocks, and concurrency hazards
- API contract mismatches (wrong types, missing fields, breaking changes)
- Missing edge cases (empty input, large input, Unicode, negative numbers, concurrent access)
- Resource leaks (unclosed handles, missing cleanup, event listener accumulation)
- Dependency concerns (known CVEs, unnecessary dependencies, version conflicts)

Structure your review using these sections — omit any section that has no findings:

### 🚨 Critical Issues
Bugs, security vulnerabilities, data loss risks, crashes.
Reference the file and line. Explain why it's critical and suggest a fix.

### ⚠️ Warnings
Potential problems, unhandled edge cases, risky patterns, tech debt.

### 💡 Suggestions
Better approaches, cleaner patterns, performance improvements, readability wins.

### 📝 Nitpicks
Minor style or naming issues. Maximum 3 items.

### ✅ What Looks Good
Briefly acknowledge well-written code, good patterns, or solid test coverage.

End with exactly one verdict line:
- ✅ **Verdict: Looks Good** — no blockers found
- ⚠️ **Verdict: Needs Attention** — non-blocking suggestions
- 🚨 **Verdict: Needs Changes** — blocking issues that must be fixed

Be brutally honest. If the code is clean, say so briefly and move on.`;

const FILE_REVIEW_PROMPT = `You are a principal software engineer reviewing a single file from a Pull Request.

Analyze the diff for bugs, security issues, performance problems, and correctness.
Be concise. Only report real findings. Reference specific lines.

If the file looks fine, respond with exactly: "No issues found."

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

function formatHeader(model: string, filesCount: number, truncated: boolean): string {
  let header = `## 🤖 AI Code Review\n\n`;
  header += `> Reviewed **${filesCount}** file${filesCount !== 1 ? "s" : ""}`;
  if (truncated) {
    header += ` (diff was truncated)`;
  }
  header += `\n\n`;
  return header;
}

function formatFooter(model: string): string {
  return `\n\n---\n<sub>Powered by [Pollinations AI](https://pollinations.ai) • Model: \`${model}\` • [Get your API key](https://enter.pollinations.ai)</sub>`;
}

async function reviewSinglePass(input: ReviewInput): Promise<ReviewResult> {
  const { diff, truncated } = buildFullDiff(input.files, input.maxDiffLength);
  const fileSummary = buildFileSummary(input.files);
  const systemPrompt = buildSystemPrompt(input.customPrompt);

  let userMessage = `Review this Pull Request.

**Title:** ${input.title}

**Description:**
${input.body || "_No description provided._"}

**Changed Files (${input.files.length}):**
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
  const header = formatHeader(input.model, input.files.length, truncated);
  const footer = formatFooter(input.model);

  return {
    body: header + review + footer,
    verdict,
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

async function reviewSplit(input: ReviewInput): Promise<ReviewResult> {
  const perFileLimit = Math.floor(input.maxDiffLength / 2);
  const chunks = chunkFiles(input.files, perFileLimit);

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

${chunk.map((f) => `- \`${f.filename}\` (${f.status}, +${f.additions}/-${f.deletions})`).join("\n")}

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
    const header = formatHeader(input.model, input.files.length, false);
    const footer = formatFooter(input.model);
    return {
      body:
        header +
        "### ✅ What Looks Good\nAll reviewed files look clean. No issues found.\n\n✅ **Verdict: Looks Good**" +
        footer,
      verdict: "APPROVE",
    };
  }

  const mergePrompt = `You are a principal software engineer. Below are per-file review findings from a PR titled "${input.title}".

PR Description: ${input.body || "No description provided."}

File findings:
${chunkResults.join("\n\n---\n\n")}

Synthesize these into a single cohesive review using this structure (omit empty sections):

### 🚨 Critical Issues
### ⚠️ Warnings
### 💡 Suggestions
### 📝 Nitpicks
### ✅ What Looks Good

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
  const header = formatHeader(input.model, input.files.length, false);
  const footer = formatFooter(input.model);

  return {
    body: header + merged + footer,
    verdict,
  };
}

export async function reviewPR(input: ReviewInput): Promise<ReviewResult> {
  const shouldSplit =
    input.splitReview && input.files.length > input.splitThreshold;

  if (shouldSplit) {
    core.info(
      `PR has ${input.files.length} files (threshold: ${input.splitThreshold}), using split review`
    );
    return reviewSplit(input);
  }

  return reviewSinglePass(input);
}