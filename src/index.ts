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

interface Annotation {
  file: string;
  line: number;
  level: "notice" | "warning" | "error";
  message: string;
}

function extractAnnotations(review: string): Annotation[] {
  const annotations: Annotation[] = [];

  const criticalMatch = review.match(/###\s*🚨\s*Critical Issues\n([\s\S]*?)(?=###|\Z)/);
  if (criticalMatch) {
    const lines = criticalMatch[1].split("\n");
    for (const line of lines) {
      if (line.includes("`") && line.trim()) {
        const match = line.match(/`([^`]+)`/);
        if (match) {
          annotations.push({
            file: match[1],
            line: 1,
            level: "error",
            message: line.replace(/`[^`]+`/g, "").trim() || "Critical issue found",
          });
        }
      }
    }
  }

  const warningsMatch = review.match(/###\s*⚠️\s*Warnings\n([\s\S]*?)(?=###|\Z)/);
  if (warningsMatch) {
    const lines = warningsMatch[1].split("\n");
    for (const line of lines) {
      if (line.includes("`") && line.trim()) {
        const match = line.match(/`([^`]+)`/);
        if (match) {
          annotations.push({
            file: match[1],
            line: 1,
            level: "warning",
            message: line.replace(/`[^`]+`/g, "").trim() || "Warning found",
          });
        }
      }
    }
  }

  return annotations;
}

function extractVerdict(review: string): "APPROVE" | "REQUEST_CHANGES" | "NEUTRAL" {
  const lowerReview = review.toLowerCase();

  if (
    lowerReview.includes("verdict: looks good") ||
    lowerReview.includes("✅") && lowerReview.includes("looks good")
  ) {
    return "APPROVE";
  }

  if (
    lowerReview.includes("verdict: needs changes") ||
    lowerReview.includes("🚨") && lowerReview.includes("needs changes")
  ) {
    return "REQUEST_CHANGES";
  }

  return "NEUTRAL";
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
    const postAsCheck = core.getInput("post-as-check") !== "false";

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
      temperature: 0.3,
    });

    core.setOutput("review", review);

    const verdict = extractVerdict(review);
    core.setOutput("verdict", verdict);

    await octokit.rest.issues.createComment({
      ...context.repo,
      issue_number: prNumber,
      body: review,
    });

    core.info(`Review posted as comment on PR #${prNumber}`);

    if (postAsCheck) {
      const annotations = extractAnnotations(review);

      const checkBody: any = {
        name: "AI Code Review",
        head_sha: context.payload.pull_request?.head.sha || context.sha,
        status: "completed",
        conclusion:
          verdict === "APPROVE"
            ? "success"
            : verdict === "REQUEST_CHANGES"
              ? "failure"
              : "neutral",
        output: {
          title: "AI Code Review",
          summary:
            verdict === "APPROVE"
              ? "✅ Review passed - no blockers found"
              : verdict === "REQUEST_CHANGES"
                ? "🚨 Review found issues that need attention"
                : "⚠️ Review completed with suggestions",
          annotations:
            annotations.length > 0
              ? annotations.slice(0, 50).map((a) => ({
                  path: a.file,
                  start_line: a.line,
                  end_line: a.line,
                  annotation_level: a.level,
                  message: a.message,
                  title: "AI Review Finding",
                }))
              : [
                  {
                    path: allFiles[0]?.filename || "README.md",
                    start_line: 1,
                    end_line: 1,
                    annotation_level: "notice",
                    message: "AI review completed",
                    title: "Review Info",
                  },
                ],
        },
      };

      try {
        await octokit.rest.checks.create({
          ...context.repo,
          ...checkBody,
        });
        core.info("Check run created successfully");
      } catch (error) {
        core.warning(`Could not create check run: ${error}`);
      }
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