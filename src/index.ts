import * as core from "@actions/core";
import * as github from "@actions/github";
import { reviewPR, FileInfo, ReviewResult, extractVerdict } from "./reviewer";

function shouldExclude(filename: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      if (filename.endsWith(ext)) return true;
    } else if (pattern.endsWith("/**")) {
      const dir = pattern.slice(0, -3);
      if (filename.startsWith(dir + "/") || filename === dir) return true;
    } else if (pattern.endsWith("/*")) {
      const dir = pattern.slice(0, -2);
      const rest = filename.slice(dir.length + 1);
      if (filename.startsWith(dir + "/") && !rest.includes("/")) return true;
    } else {
      if (filename === pattern || filename.endsWith("/" + pattern))
        return true;
    }
  }
  return false;
}

async function resolvePRNumber(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context
): Promise<number | null> {
  if (
    context.eventName === "pull_request" ||
    context.eventName === "pull_request_target"
  ) {
    return context.payload.pull_request?.number ?? null;
  }

  if (context.eventName === "issue_comment") {
    const isPR = !!context.payload.issue?.pull_request;
    const body = (context.payload.comment?.body ?? "").toLowerCase().trim();

    if (isPR && body.includes("/review")) {
      return context.payload.issue?.number ?? null;
    }
  }

  return null;
}

async function fetchAllFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  repo: { owner: string; repo: string },
  prNumber: number
): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  let page = 1;

  while (true) {
    const { data: batch } = await octokit.rest.pulls.listFiles({
      ...repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });

    if (batch.length === 0) break;

    for (const f of batch) {
      files.push({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      });
    }

    if (batch.length < 100) break;
    page++;
  }

  return files;
}

interface Annotation {
  file: string;
  line: number;
  level: "notice" | "warning" | "failure";
  message: string;
}

function extractAnnotations(review: string, files: FileInfo[]): Annotation[] {
  const annotations: Annotation[] = [];
  const validFiles = new Set(files.map((f) => f.filename));

  const sectionPatterns: Array<{
    regex: RegExp;
    level: "failure" | "warning" | "notice";
  }> = [
    { regex: /###\s*🚨\s*Critical Issues\n([\s\S]*?)(?=\n###|\n---|\n✅\s*\*\*|$)/i, level: "failure" },
    { regex: /###\s*⚠️\s*Warnings\n([\s\S]*?)(?=\n###|\n---|\n✅\s*\*\*|$)/i, level: "warning" },
    { regex: /###\s*💡\s*Suggestions\n([\s\S]*?)(?=\n###|\n---|\n✅\s*\*\*|$)/i, level: "notice" },
  ];

  for (const { regex, level } of sectionPatterns) {
    const match = review.match(regex);
    if (!match) continue;

    const content = match[1];
    const fileRefs = content.matchAll(/`([^`]+?)`/g);

    for (const ref of fileRefs) {
      const candidate = ref[1].trim();
      if (validFiles.has(candidate)) {
        const lineMatch = content.match(
          new RegExp(`\`${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`[^\\n]*(?:line\\s*(\\d+))`, "i")
        );

        const surroundingText = content
          .split("\n")
          .find((l) => l.includes(candidate));

        annotations.push({
          file: candidate,
          line: lineMatch?.[1] ? parseInt(lineMatch[1], 10) : 1,
          level,
          message:
            surroundingText
              ?.replace(/`[^`]*`/g, "")
              .replace(/^[-*•]\s*/, "")
              .trim() || `${level === "failure" ? "Critical issue" : level === "warning" ? "Warning" : "Suggestion"} found`,
        });
      }
    }
  }

  const seen = new Set<string>();
  return annotations.filter((a) => {
    const key = `${a.file}:${a.line}:${a.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function addReaction(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  reaction: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes"
): Promise<void> {
  try {
    await octokit.rest.reactions.createForIssueComment({
      ...context.repo,
      comment_id: context.payload.comment!.id,
      content: reaction,
    });
  } catch {
    core.debug(`Could not add ${reaction} reaction`);
  }
}

async function postReview(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  prNumber: number,
  result: ReviewResult,
  postAsReview: boolean,
  headSha: string
): Promise<void> {
  if (postAsReview) {
    const event =
      result.verdict === "APPROVE"
        ? "APPROVE"
        : result.verdict === "REQUEST_CHANGES"
          ? "REQUEST_CHANGES"
          : "COMMENT";

    try {
      await octokit.rest.pulls.createReview({
        ...context.repo,
        pull_number: prNumber,
        commit_id: headSha,
        body: result.body,
        event,
      });
      core.info(`Posted formal PR review (${event}) on PR #${prNumber}`);
      return;
    } catch (error) {
      core.warning(`Could not post as review, falling back to comment: ${error}`);
    }
  }

  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: prNumber,
    body: result.body,
  });
  core.info(`Posted review comment on PR #${prNumber}`);
}

async function createCheckRun(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  result: ReviewResult,
  annotations: Annotation[],
  headSha: string,
  fallbackFile: string
): Promise<void> {
  const conclusion =
    result.verdict === "APPROVE"
      ? "success"
      : result.verdict === "REQUEST_CHANGES"
        ? "failure"
        : "neutral";

  const summaryMap = {
    success: "✅ Code review passed — no blocking issues found",
    failure: "🚨 Code review found issues that need attention",
    neutral: "⚠️ Code review completed with suggestions",
  };

  const checkAnnotations =
    annotations.length > 0
      ? annotations.slice(0, 50).map((a) => ({
          path: a.file,
          start_line: a.line,
          end_line: a.line,
          annotation_level: a.level as "notice" | "warning" | "failure",
          message: a.message,
          title: "AI Review Finding",
        }))
      : [
          {
            path: fallbackFile,
            start_line: 1,
            end_line: 1,
            annotation_level: "notice" as const,
            message: "AI code review completed. See PR comment for details.",
            title: "Review Complete",
          },
        ];

  try {
    await octokit.rest.checks.create({
      ...context.repo,
      name: "AI Code Review",
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: {
        title: "AI Code Review",
        summary: summaryMap[conclusion],
        annotations: checkAnnotations,
      },
    });
    core.info(`Check run created (${conclusion})`);
  } catch (error) {
    core.warning(`Could not create check run: ${error}`);
  }
}

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput("pollinations-api-key", { required: true });
    const token = core.getInput("github-token", { required: true });
    const model = core.getInput("model") || "openai";
    const maxDiffLength = parseInt(core.getInput("max-diff-length") || "30000", 10);
    const excludeRaw = core.getInput("exclude-files") || "";
    const customPrompt = core.getInput("custom-prompt") || "";
    const postAsReview = core.getInput("post-as-review") === "true";
    const postAsCheck = core.getInput("post-as-check") !== "false";
    const temperature = parseFloat(core.getInput("temperature") || "0.3");
    const maxRetries = parseInt(core.getInput("max-retries") || "3", 10);
    const splitReview = core.getInput("split-review") !== "false";
    const splitThreshold = parseInt(core.getInput("split-threshold") || "8", 10);

    const excludePatterns = excludeRaw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    const octokit = github.getOctokit(token);
    const context = github.context;

    const prNumber = await resolvePRNumber(octokit, context);
    if (!prNumber) {
      core.info("No applicable PR found. Skipping.");
      return;
    }

    if (context.eventName === "issue_comment") {
      await addReaction(octokit, context, "eyes");
    }

    core.info(
      `Reviewing PR #${prNumber} in ${context.repo.owner}/${context.repo.repo}`
    );
    core.info(`Model: ${model} | Temperature: ${temperature} | Split: ${splitReview}`);

    const { data: pr } = await octokit.rest.pulls.get({
      ...context.repo,
      pull_number: prNumber,
    });

    const allFiles = await fetchAllFiles(octokit, context.repo, prNumber);

    const files = allFiles.filter(
      (f) => !shouldExclude(f.filename, excludePatterns)
    );

    core.info(
      `Found ${allFiles.length} changed files, ${files.length} after filtering`
    );

    if (files.length === 0) {
      core.info("No reviewable files after filtering. Skipping.");
      return;
    }

    core.info("Sending to Pollinations AI for review...");

    const result = await reviewPR({
      title: pr.title,
      body: pr.body || "",
      files,
      apiKey,
      model,
      maxDiffLength,
      customPrompt,
      temperature,
      maxRetries,
      splitReview,
      splitThreshold,
    });

    core.setOutput("review", result.body);
    core.setOutput("verdict", result.verdict);
    core.setOutput("files-reviewed", String(files.length));

    const headSha =
      context.payload.pull_request?.head?.sha || pr.head.sha || context.sha;

    await postReview(octokit, context, prNumber, result, postAsReview, headSha);

    if (context.eventName === "issue_comment") {
      const emoji = result.verdict === "APPROVE" ? "rocket" : "hooray";
      await addReaction(octokit, context, emoji);
    }

    if (postAsCheck) {
      const annotations = extractAnnotations(result.body, files);
      await createCheckRun(
        octokit,
        context,
        result,
        annotations,
        headSha,
        allFiles[0]?.filename || "README.md"
      );
    }

    core.info(`Review complete. Verdict: ${result.verdict}`);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();