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
}

const SYSTEM_PROMPT = `You are a senior software engineer performing a code review on a GitHub Pull Request.

Your review must be:
- Concise, specific, and actionable
- Focused on real issues, not nitpicking formatting unless egregious
- Constructive and professional

Look for:
- Bugs and logic errors
- Security vulnerabilities (injection, auth issues, data exposure)
- Performance problems (N+1 queries, unnecessary allocations, blocking calls)
- Error handling gaps (uncaught exceptions, missing validation)
- Race conditions and concurrency issues
- API contract violations
- Missing edge cases

Structure your review with these sections (skip empty ones):

### 🚨 Critical Issues
Bugs, security vulnerabilities, data loss risks.

### ⚠️ Warnings
Potential problems, unhandled edge cases, risky patterns.

### 💡 Suggestions
Better approaches, cleaner patterns, performance improvements.

### 📝 Nitpicks
Minor style or naming issues. Keep this very short.

### ✅ What Looks Good
Briefly note well-written code.

End with one of:
- ✅ **Verdict: Looks Good** — no blockers found
- ⚠️ **Verdict: Needs Attention** — minor issues to address
- 🚨 **Verdict: Needs Changes** — blocking issues found

Be honest. If the code is fine, say so briefly. Don't invent problems.`;

export async function reviewPR(input: ReviewInput): Promise<string> {
  const fileSummary = input.files
    .map(
      (f) =>
        `- \`${f.filename}\` (${f.status}, +${f.additions}/-${f.deletions})`
    )
    .join("\n");

  let diff = input.files
    .filter((f) => f.patch)
    .map((f) => `diff --git a/${f.filename} b/${f.filename}\n${f.patch}`)
    .join("\n\n");

  let truncated = false;
  if (diff.length > input.maxDiffLength) {
    diff = diff.substring(0, input.maxDiffLength);
    truncated = true;
  }

  let systemPrompt = SYSTEM_PROMPT;
  if (input.customPrompt) {
    systemPrompt += `\n\nAdditional instructions from the repository maintainer:\n${input.customPrompt}`;
  }

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
      "\n\n⚠️ The diff was truncated due to size. Focus on reviewing what is shown above.";
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
    options
  );

  const header = "## 🤖 AI Code Review\n\n";
  const footer = `\n\n---\n<sub>Powered by [Pollinations AI](https://pollinations.ai) • Model: \`${input.model}\` • [Add to your repo](https://github.com/yourusername/pollinations-pr-reviewer)</sub>`;

  return header + review + footer;
}