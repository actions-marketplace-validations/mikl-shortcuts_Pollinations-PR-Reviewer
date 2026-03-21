import * as core from "@actions/core";
import * as github from "@actions/github";
import { reviewPR, FileInfo } from "./reviewer";

function shouldExclude(filename: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.startsWith("*.")) {
      if (filename.endsWith(pattern.slice(1))) return true;
    } else if (pattern.endsWith("/**")) {
      const dir = pattern.slice(0, -3);
      if (filename.startsWith(dir + "/") || filename === dir) return true;
    } else if (pattern.endsWith("/*")) {
      const dir = pattern.slice(0, -2);
      if (
        filename.startsWith(dir + "/") &&
        !filename.slice(dir.length + 1).includes("/")
      )
        return true;
    } else {
      if (filename === pattern || filename.endsWith("/" + pattern))
        return true;
    }
  }
  return false;
}

async function getPRNumber(): Promise<number | null> {
  const context = github.context;

  if (
    context.eventName === "pull_request" ||
    context.eventName === "pull_request_target"
  ) {
    return context.payload.pull_request?.number ?? null;
  }

  if (context.eventName === "issue_comment") {
    const isPR = !!context.payload.issue?.pull_request;
    const body = (context.payload.comment?.body ?? "").toLowerCase();

    if (isPR && body.includes("/review")) {
      return context.payload.issue?.number ?? null;
    }
  }

  return null;
}

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput("pollinations-api-key", { required: true });
    const token = core.getInput("github-token", { required: true });
    const model = core.getInput("model") || "openai";
    const maxDiffLength = parseInt(
      core.getInput("max-diff-length") || "30000",
      10
    );
    const excludeRaw = core.getInput("exclude-files") || "";
    const customPrompt = core.getInput("custom-prompt") || "";
    const postAsReview = core.getInput("post-as-review") === "true";
    const temperature = parseFloat(core.getInput("temperature") || "0.3");

    if (!apiKey.startsWith("sk_") && !apiKey.startsWith("pk_")) {
      core.warning(
        "API key does not start with sk_ or pk_. Make sure you're using a valid Pollinations API key from https://enter.pollinations.ai"
      );
    }

    const excludePatterns = excludeRaw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    const octokit = github.getOctokit(token);
    const context = github.context;

    const prNumber = await getPRNumber();
    if (!prNumber) {
      core.info("No applicable PR found. Skipping.");
      return;
    }

    if (context.eventName === "issue_comment") {
      try {
        await octokit.rest.reactions.createForIssueComment({
          ...context.repo,
          comment_id: context.payload.comment!.id,
          content: "eyes",
        });
      } catch {
        core.debug("Could not add reaction to comment");
      }
    }

    core.info(
      `Reviewing PR #${prNumber} in ${context.repo.owner}/${context.repo.repo}`
    );
    core.info(`Model: ${model}`);

    const { data: pr } = await octokit.rest.pulls.get({
      ...context.repo,
      pull_number: prNumber,
    });

    const allFiles: FileInfo[] = [];
    let page = 1;
    while (true) {
      const { data: batch } = await octokit.rest.pulls.listFiles({
        ...context.repo,
        pull_number: prNumber,
        per_page: 100,
        page,
      });

      if (batch.length === 0) break;

      for (const f of batch) {
        allFiles.push({
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

    const review = await reviewPR({
      title: pr.title,
      body: pr.body || "",
      files,
      apiKey,
      model,
      maxDiffLength,
      customPrompt,
      temperature,
    });

    core.setOutput("review", review);

    if (postAsReview) {
      await octokit.rest.pulls.createReview({
        ...context.repo,
        pull_number: prNumber,
        body: review,
        event: "COMMENT",
      });
      core.info(`Review posted as PR review on #${prNumber}`);
    } else {
      await octokit.rest.issues.createComment({
        ...context.repo,
        issue_number: prNumber,
        body: review,
      });
      core.info(`Review posted as comment on #${prNumber}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();