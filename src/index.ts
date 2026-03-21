import * as core from "@actions/core";
import * as github from "@actions/github";
import { reviewPR, FileInfo, ReviewResult, InlineComment, extractVerdict } from "./reviewer";

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

    if (!data.tree || data.tree.length === 0) return "";

    const skipPatterns = [
      "node_modules/",
      ".git/",
      "dist/",
      "build/",
      ".next/",
      "__pycache__/",
      ".venv/",
      "vendor/",
      "coverage/",
      ".cache/",
    ];

    const skipExtensions = [
      ".lock",
      ".map",
      ".min.js",
      ".min.css",
      ".svg",
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".ico",
      ".woff",
      ".woff2",
      ".ttf",
      ".eot",
    ];

    const entries = data.tree
      .filter((item) => {
        const path = item.path || "";
        if (skipPatterns.some((p) => path.startsWith(p) || path.includes("/" + p)))
          return false;
        if (item.type === "blob" && skipExtensions.some((ext) => path.endsWith(ext)))
          return false;
        return true;
      })
      .map((item) => {
        const prefix = item.type === "tree" ? "📁 " : "   ";
        return `${prefix}${item.path}`;
      });

    if (entries.length > 200) {
      return entries.slice(0, 200).join("\n") + "\n... (truncated)";
    }

    return entries.join("\n");
  } catch (error) {
    core.debug(`Could not fetch project structure: ${error}`);
    return "";
  }
}

function buildCheckAnnotations(
  inlineComments: InlineComment[],
  fallbackFile: string
): Array<{
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title: string;
}> {
  if (inlineComments.length === 0) {
    return [
      {
        path: fallbackFile,
        start_line: 1,
        end_line: 1,
        annotation_level: "notice",
        message: "AI code review completed. See PR comment for details.",
        title: "Review Complete",
      },
    ];
  }

  return inlineComments.slice(0, 50).map((c) => {
    let level: "notice" | "warning" | "failure" = "notice";
    if (c.body.startsWith("🚨")) level = "failure";
    else if (c.body.startsWith("⚠️")) level = "warning";

    return {
      path: c.path,
      start_line: c.line,
      end_line: c.line,
      annotation_level: level,
      message: c.body.replace(/^[🚨⚠️💡💬]\s*/, ""),
      title: level === "failure"
        ? "Critical Issue"
        : level === "warning"
          ? "Warning"
          : "Suggestion",
    };
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

async function postInlineComments(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  prNumber: number,
  headSha: string,
  comments: InlineComment[]
): Promise<number> {
  if (comments.length === 0) return 0;

  let posted = 0;

  try {
    await octokit.rest.pulls.createReview({
      ...context.repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: "COMMENT",
      comments: comments.slice(0, 30).map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side,
        body: c.body,
      })),
    });
    posted = Math.min(comments.length, 30);
    core.info(`Posted ${posted} inline review comments via batch review`);
  } catch (batchError) {
    core.warning(`Batch inline comments failed, posting individually: ${batchError}`);

    for (const comment of comments.slice(0, 20)) {
      try {
        await octokit.rest.pulls.createReviewComment({
          ...context.repo,
          pull_number: prNumber,
          commit_id: headSha,
          path: comment.path,
          line: comment.line,
          side: comment.side,
          body: comment.body,
        });
        posted++;
      } catch (err) {
        core.debug(`Could not post inline comment on ${comment.path}:${comment.line}: ${err}`);
      }
    }

    if (posted > 0) {
      core.info(`Posted ${posted} inline comments individually`);
    }
  }

  return posted;
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

  const annotations = buildCheckAnnotations(result.inlineComments, fallbackFile);

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
        text: result.inlineComments.length > 0
          ? `Found ${result.inlineComments.length} issue(s) across the changed files.`
          : "No specific line-level issues found.",
        annotations,
      },
    });
    core.info(`Check run created (${conclusion}) with ${annotations.length} annotation(s)`);
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

    const headSha =
      context.payload.pull_request?.head?.sha || pr.head.sha || context.sha;

    const [allFiles, projectStructure] = await Promise.all([
      fetchAllFiles(octokit, context.repo, prNumber),
      fetchProjectStructure(octokit, context.repo, headSha),
    ]);

    if (projectStructure) {
      core.info(`Fetched project structure (${projectStructure.split("\n").length} entries)`);
    }

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
      projectStructure,
    });

    core.setOutput("review", result.body);
    core.setOutput("verdict", result.verdict);
    core.setOutput("files-reviewed", String(files.length));

    core.info(`Extracted ${result.inlineComments.length} inline comment(s) from review`);

    const inlinePosted = await postInlineComments(
      octokit,
      context,
      prNumber,
      headSha,
      result.inlineComments
    );

    await postSummaryComment(octokit, context, prNumber, result, postAsReview, headSha);

    if (context.eventName === "issue_comment") {
      const emoji = result.verdict === "APPROVE" ? "rocket" : "hooray";
      await addReaction(octokit, context, emoji);
    }

    if (postAsCheck) {
      await createCheckRun(octokit, context, result, headSha, allFiles[0]?.filename || "README.md");
    }

    core.info(
      `Review complete. Verdict: ${result.verdict} | Inline comments: ${inlinePosted} | Check: ${postAsCheck}`
    );
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();