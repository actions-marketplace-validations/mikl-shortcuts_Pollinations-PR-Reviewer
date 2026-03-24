# Pollinations PR Reviewer

AI-powered code reviews for your GitHub Pull Requests using [Pollinations AI](https://pollinations.ai).

No servers to deploy. No infrastructure. Just a workflow file and an API key.

## Quick Start

### 1. Get a Pollinations API key

Go to [enter.pollinations.ai](https://enter.pollinations.ai) and create an API key.

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
        uses: mikl-shortcuts/Pollinations-PR-Reviewer@v
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
- **Request timeout** protection (120s per API call)
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
- uses: mikl-shortcuts/Pollinations-PR-Reviewer@v
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
      - uses: mikl-shortcuts/Pollinations-PR-Reviewer@v
        with:
          pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### With Custom Instructions

```yaml
- uses: mikl-shortcuts/Pollinations-PR-Reviewer@v
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
- uses: mikl-shortcuts/Pollinations-PR-Reviewer@v
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
      - uses: mikl-shortcuts/Pollinations-PR-Reviewer@v
        with:
          pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Post as Formal PR Review

```yaml
- uses: mikl-shortcuts/Pollinations-PR-Reviewer@v
  with:
    pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    post-as-review: "true"
```

### Gate Merging on AI Review

```yaml
steps:
  - id: ai-review
    uses: mikl-shortcuts/Pollinations-PR-Reviewer@v
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

| Type | Prefix | Use Case | Rate Limit |
|------|--------|----------|------------|
| Secret | `sk_` | Server-side (recommended) | None |
| Publishable | `pk_` | Client-side apps | 1 pollen/IP/hour |

Use a `sk_` key stored as a GitHub secret. Never commit API keys.

---

## FAQ

**Where do I get an API key?**
[enter.pollinations.ai](https://enter.pollinations.ai) — sign in and create a key.

**How much does it cost?**
Each review consumes Pollen. Cost depends on model and diff size. Check balance at `gen.pollinations.ai/account/balance`.

**What models can I use?**
Any model at [gen.pollinations.ai/v1/models](https://gen.pollinations.ai/v1/models).

**Is my code sent to a third party?**
The PR diff is sent to Pollinations AI for analysis. Don't use this on repos with confidential code.

**What about large PRs?**
With `split-review: true` (default), large PRs are reviewed file-by-file and findings are merged. This produces better results than truncating.

**The review didn't appear — what happened?**
Check the Actions tab for error logs. Common issues:
- Invalid API key
- Insufficient pollen balance
- Missing `permissions` block in workflow
- API timeout on very large diffs

**Can I use this in a private repo?**
Yes. Be aware the diff is sent to Pollinations AI.

---

## Development

```bash
git clone https://github.com/mikl-shortcuts/Pollinations-PR-Reviewer.git
cd Pollinations-PR-Reviewer
npm install
npm run build
```

```bash
git add -A
git commit -m "v1.0.0"
git tag -a v1 -m "v1.0.0"
git push origin main --tags
```