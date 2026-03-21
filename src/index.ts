import * as core from "@actions/core";
import * as github from "@actions/github";
import { reviewPR, FileInfo, ReviewResult, InlineComment } from "./reviewer";

function shouldExclude(filename: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.startsWith("*.")) {
      if (filename.endsWith(pattern.slice(1))) return true;
    } else if (pattern.endsWith("/**")) {
      const dir = pattern.slice(0, -3);
      if (filename.startsWith(dir + "/") || filename === dir) return true;
    } else if (pattern.endsWith("/*")) {
      const dir = pattern.slice(0, -2);
      const rest = filename.slice(dir.length + 1);
      if (filename.startsWith(dir + "/") && !rest.includes("/")) return true;
    } else {
      if (filename === pattern || filename.endsWith("/" + pattern)) return true;
    }
  }
  return false;
}

async function resolvePRNumber(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context
): Promise<number | null> {
  if (context.eventName === "pull_request" || context.eventName === "pull_request_target") {
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

async function fetchProjectStructure(
  octokit: ReturnType<typeof github.getOctokit>,
  repo: { owner: string; repo: string },
  ref: string
): Promise<string> {
  try {
    const { data } = await octokit.rest.git.getTree({
      ...repo,
      tree_sha: ref,
      recursive: "1",
    });

    if (!data.tree?.length) return "";

    const skip = ["node_modules/", ".git/", "dist/", "build/", ".next/", "__pycache__/", ".venv/", "vendor/", "coverage/"];
    const skipExt = [".lock", ".map", ".min.js", ".min.css", ".svg", ".png", ".jpg", ".gif", ".ico", ".woff", ".woff2"];

    const entries = data.tree
      .filter((item) => {
        const p = item.path || "";
        if (skip.some((s) => p.startsWith(s) || p.includes("/" + s))) return false;
        if (item.type === "blob" && skipExt.some((e) => p.endsWith(e))) return false;
        return true;
      })
      .slice(0, 150)
      .map((item) => (item.type === "tree" ? `📁 ${item.path}` : `   ${item.path}`));

    return entries.join("\n");
  } catch {
    return "";
  }
}

async function addReaction(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  reaction: "eyes" | "rocket" | "hooray"
): Promise<void> {
  try {
    await octokit.rest.reactions.createForIssueComment({
      ...context.repo,
      comment_id: context.payload.comment!.id,
      content: reaction,
    });
  } catch {}
}

async function postInlineComments(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  prNumber: number,
  headSha: string,
  comments: InlineComment[]
): Promise<number> {
  if (comments.length === 0) return 0;

  const formatted = comments.map((c) => {
    const icon = c.severity === "critical" ? "🚨" : c.severity === "warning" ? "⚠️" : "💡";
    return {
      path: c.path,
      line: c.line,
      side: c.side as "RIGHT",
      body: `${icon} ${c.body}`,
    };
  });

  try {
    await octokit.rest.pulls.createReview({
      ...context.repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: "COMMENT",
      comments: formatted,
    });
    core.info(`Posted ${formatted.length} inline comments`);
    return formatted.length;
  } catch (err) {
    core.warning(`Batch comments failed: ${err}`);

    let posted = 0;
    for (const c of formatted.slice(0, 5)) {
      try {
        await octokit.rest.pulls.createReviewComment({
          ...context.repo,
          pull_number: prNumber,
          commit_id: headSha,
          path: c.path,
          line: c.line,
          side: "RIGHT",
          body: c.body,
        });
        posted++;
      } catch {}
    }
    return posted;
  }
}

async function postSummaryComment(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  prNumber: number,
  result: ReviewResult,
  postAsReview: boolean,
  headSha: string
): Promise<void> {
  if (postAsReview) {
    const event = result.verdict === "APPROVE" ? "APPROVE" : result.verdict === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "COMMENT";
    try {
      await octokit.rest.pulls.createReview({
        ...context.repo,
        pull_number: prNumber,
        commit_id: headSha,
        body: result.body,
        event,
      });
      return;
    } catch {}
  }

  await octokit.rest.issues.createComment({
    ...context.repo,
    issue_number: prNumber,
    body: result.body,
  });
}

async function createCheckRun(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  result: ReviewResult,
  headSha: string,
  fallbackFile: string
): Promise<void> {
  const conclusion = result.verdict === "APPROVE" ? "success" : result.verdict === "REQUEST_CHANGES" ? "failure" : "neutral";

  const annotations = result.inlineComments.length > 0
    ? result.inlineComments.slice(0, 50).map((c) => ({
        path: c.path,
        start_line: c.line,
        end_line: c.line,
        annotation_level: (c.severity === "critical" ? "failure" : c.severity === "warning" ? "warning" : "notice") as "failure" | "warning" | "notice",
        message: c.body,
        title: c.severity === "critical" ? "Critical" : c.severity === "warning" ? "Warning" : "Suggestion",
      }))
    : [{
        path: fallbackFile,
        start_line: 1,
        end_line: 1,
        annotation_level: "notice" as const,
        message: "Review complete",
        title: "AI Review",
      }];

  try {
    await octokit.rest.checks.create({
      ...context.repo,
      name: "AI Code Review",
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: {
        title: "AI Code Review",
        summary: result.verdict === "APPROVE" ? "✅ No issues" : result.verdict === "REQUEST_CHANGES" ? "🚨 Issues found" : "⚠️ Suggestions",
        annotations,
      },
    });
  } catch (e) {
    core.warning(`Check run failed: ${e}`);
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

    const excludePatterns = excludeRaw.split(",").map((p) => p.trim()).filter(Boolean);

    const octokit = github.getOctokit(token);
    const context = github.context;

    const prNumber = await resolvePRNumber(octokit, context);
    if (!prNumber) {
      core.info("No PR found");
      return;
    }

    if (context.eventName === "issue_comment") {
      await addReaction(octokit, context, "eyes");
    }

    core.info(`Reviewing PR #${prNumber}`);

    const { data: pr } = await octokit.rest.pulls.get({ ...context.repo, pull_number: prNumber });
    const headSha = context.payload.pull_request?.head?.sha || pr.head.sha || context.sha;

    const [allFiles, projectStructure] = await Promise.all([
      fetchAllFiles(octokit, context.repo, prNumber),
      fetchProjectStructure(octokit, context.repo, headSha),
    ]);

    const files = allFiles.filter((f) => !shouldExclude(f.filename, excludePatterns));
    core.info(`${files.length} files to review`);

    if (files.length === 0) {
      core.info("No files after filtering");
      return;
    }

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
      projectStructure,
    });

    core.setOutput("review", result.body);
    core.setOutput("verdict", result.verdict);
    core.setOutput("files-reviewed", String(files.length));

    core.info(`${result.inlineComments.length} inline comments extracted`);

    await postInlineComments(octokit, context, prNumber, headSha, result.inlineComments);
    await postSummaryComment(octokit, context, prNumber, result, postAsReview, headSha);

    if (context.eventName === "issue_comment") {
      await addReaction(octokit, context, result.verdict === "APPROVE" ? "rocket" : "hooray");
    }

    if (postAsCheck) {
      await createCheckRun(octokit, context, result, headSha, allFiles[0]?.filename || "README.md");
    }

    core.info(`Done. Verdict: ${result.verdict}`);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : "Unknown error");
  }
}

run();