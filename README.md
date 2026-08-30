# Pollinations PR Reviewer

AI-powered code reviews for your GitHub Pull Requests using [Pollinations AI](https://pollinations.ai).

No servers to deploy. No infrastructure. Just a workflow file and an API key.

## Quick Start

### 1. Get a Pollinations API key

Go to [Pollinations Dashboard](https://enter.pollinations.ai) or [Pollinations CLI](https://github.com/pollinations/pollinations/tree/main/packages/polli-cli) and create an API key.

### 2. Add the key to your repo secrets

Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

- Name: `POLLINATIONS_API_KEY`
- Value: your `sk_...` key

### 3. Create the workflow file

Create `.github/workflows/pr-review.yml`:

```yaml
name: AI PR Review

on:
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write

jobs:
  review:
    if: |
      github.event_name == 'pull_request' ||
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '/review'))
    runs-on: ubuntu-latest
    steps:
      - name: AI Code Review
        uses: mikl-shortcuts/Pollinations-PR-Reviewer@v1
        with:
          pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

Commit, push, open a PR. Done.

---

## How It Works

```
You open a PR
      ↓
GitHub triggers this Action
      ↓
Action reads the PR diff via GitHub API
      ↓
Diff is sent to Pollinations AI for analysis
      ↓
Review is posted as a comment + check run on your PR
```

---

## Features

- **Automatic reviews** on PR open and new commits
- **On-demand reviews** via `/review` comment
- **Split review mode** for large PRs — reviews file-by-file, then synthesizes
- **GitHub Check Runs** with inline annotations
- **Formal PR reviews** with approve/request changes
- **Smart file filtering** to skip generated files
- **Retry with backoff** for transient API errors
- **Request timeout** protection with configurable limits
- **Reasoning support** for models utilizing reasoning effort
- **Verdict extraction** (APPROVE / REQUEST_CHANGES / COMMENT)

---

## Usage

| Trigger | What Happens |
|---------|-------------|
| Open a PR | Automatic review |
| Push new commits to a PR | Automatic re-review |
| Comment `/review` on a PR | On-demand review |

---

## Configuration

```yaml
- uses: mikl-shortcuts/Pollinations-PR-Reviewer@v1
  with:
    pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    model: "openai"
    max-diff-length: "30000"
    exclude-files: "*.lock,*.min.js,docs/**"
    custom-prompt: "This is a React + TypeScript project."
    post-as-review: "false"
    post-as-check: "true"
    temperature: "0.3"
    max-retries: "3"
    split-review: "true"
    split-threshold: "8"
    reasoning-effort: "medium"
    timeout: "120"
```

### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `pollinations-api-key` | Pollinations API key (`sk_` or `pk_`) | ✅ | — |
| `github-token` | GitHub token | ✅ | `${{ github.token }}` |
| `model` | AI model | ❌ | `openai` |
| `max-diff-length` | Max diff chars before truncation | ❌ | `30000` |
| `exclude-files` | Comma-separated file patterns to skip | ❌ | `*.lock,*.min.js,...` |
| `custom-prompt` | Extra instructions for the AI | ❌ | — |
| `post-as-review` | Post as formal PR review | ❌ | `false` |
| `post-as-check` | Create a GitHub check run | ❌ | `true` |
| `temperature` | AI temperature (0.0–2.0) | ❌ | `0.3` |
| `max-retries` | Max retry attempts for API calls | ❌ | `3` |
| `split-review` | Review large PRs file-by-file | ❌ | `true` |
| `split-threshold` | File count threshold for split mode | ❌ | `8` |
| `reasoning-effort` | Reasoning effort level for reasoning models (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) | ❌ | — |
| `timeout` | Request timeout limit per API call in seconds | ❌ | `120` |

### Outputs

| Output | Description |
|--------|-------------|
| `review` | The full generated review text |
| `verdict` | Review verdict: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` |
| `files-reviewed` | Number of files reviewed |

---

## Examples

### Minimal

```yaml
name: AI PR Review
on:
  pull_request:
    types: [opened, synchronize]
permissions:
  contents: read
  pull-requests: write
  checks: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: mikl-shortcuts/Pollinations-PR-Reviewer@v1
        with:
          pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### With Custom Instructions

```yaml
- uses: mikl-shortcuts/Pollinations-PR-Reviewer@v1
  with:
    pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    model: "openai"
    custom-prompt: |
      Project context:
      - Next.js 14 with App Router
      - TypeScript strict mode
      - Prisma ORM for database
      
      Pay special attention to:
      - Server vs client component boundaries
      - SQL injection via raw queries
      - Missing error boundaries
```

### Only Review Source Code

```yaml
- uses: mikl-shortcuts/Pollinations-PR-Reviewer@v1
  with:
    pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    exclude-files: "*.lock,*.json,*.md,*.txt,*.yml,*.yaml,docs/**,*.svg,*.png,*.jpg"
```

### On-Demand Only

```yaml
name: AI PR Review
on:
  issue_comment:
    types: [created]
permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write
jobs:
  review:
    if: contains(github.event.comment.body, '/review')
    runs-on: ubuntu-latest
    steps:
      - uses: mikl-shortcuts/Pollinations-PR-Reviewer@v1
        with:
          pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Post as Formal PR Review

```yaml
- uses: mikl-shortcuts/Pollinations-PR-Reviewer@v1
  with:
    pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    post-as-review: "true"
```

### Reasoning Models Configuration

```yaml
- uses: mikl-shortcuts/Pollinations-PR-Reviewer@v1
  with:
    pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    model: "deepseek-pro"
    reasoning-effort: "high"
    timeout: "180"
```

### Gate Merging on AI Review

```yaml
steps:
  - id: ai-review
    uses: mikl-shortcuts/Pollinations-PR-Reviewer@v1
    with:
      pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
      github-token: ${{ secrets.GITHUB_TOKEN }}
  - name: Block on critical issues
    if: steps.ai-review.outputs.verdict == 'REQUEST_CHANGES'
    run: |
      echo "AI review found blocking issues"
      exit 1
```

---

## API Key Types

| Type | Where to Get It? | Prefix | Use Case | Rate Limit |
|------|------------|--------|----------|------------|
| Secret | [Pollinations Dashboard](https://enter.pollinations.ai/#keys) | `sk_` | Server-side (recommended) | None |
| Publishable | [Pollinations CLI](https://github.com/pollinations/pollinations/tree/main/packages/polli-cli#account) or [Pollinations API](https://gen.pollinations.ai/docs#tag/account/POST/account/keys) | `pk_` | Client-side apps | 1 pollen/IP/hour |

Use a `sk_` key stored as a GitHub secret. Never commit API keys.

---

## FAQ

**Where do I get my first Pollinations API key?**
[Pollinations Dashboard](https://enter.pollinations.ai) — sign in and create a key.

**How much does it cost?**
Each review consumes Pollen. Cost depends on model and diff size. Check models pricing at [Pollinations Models List](https://enter.pollinations.ai/#models) and your balance at [Pollinations Wallet](https://enter.pollinations.ai/#pollen).

**What models can I use?**
Any model that avaiable at [Pollinations Models List](https://enter.pollinations.ai/#models).

**Is my code sent to a third party?**
Yes, the PR diff is sent to Pollinations AI for analysis. You can check [Pollinations Privacy Policy](https://pollinations.ai/privacy) for more information.

**What about large PRs?**
With `split-review: true` (default), large PRs are reviewed file-by-file and findings are merged. This produces better results than truncating.

**The review didn't appear — what happened?**
Check the Actions tab for error logs. Common issues:
- Invalid API key
- Insufficient pollen balance
- Missing `permissions` block in workflow
- API timeout on very large diffs (can be resolved by increasing the `timeout` setting)

**Can I use this in a private repo?**
Yes. You can check [Pollinations Privacy Policy](https://pollinations.ai/privacy) for more information.