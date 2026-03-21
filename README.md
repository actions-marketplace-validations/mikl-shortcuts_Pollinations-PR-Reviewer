# Pollinations PR Reviewer

AI-powered code reviews for your GitHub Pull Requests using [Pollinations AI](https://pollinations.ai).

No servers to deploy. Just add a workflow file and your API key.

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
GitHub runs this Action (on GitHub's servers)
      ↓
Action reads the PR diff via GitHub API
      ↓
Diff is sent to gen.pollinations.ai with your API key
      ↓
AI review is posted as a comment on your PR
```

No servers. No infrastructure. Just a workflow file and an API key.

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
- uses: yourusername/pollinations-pr-reviewer@v1
  with:
    pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    model: "openai"
    max-diff-length: "30000"
    exclude-files: "*.lock,*.min.js,docs/**"
    custom-prompt: "This is a React + TypeScript project."
    post-as-review: "false"
    temperature: "0.3"
```

### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `pollinations-api-key` | Pollinations API key (`sk_` or `pk_`) | ✅ | — |
| `github-token` | GitHub token | ✅ | `${{ github.token }}` |
| `model` | AI model ([see available](https://gen.pollinations.ai/v1/models)) | ❌ | `openai` |
| `max-diff-length` | Max diff chars before truncation | ❌ | `30000` |
| `exclude-files` | Comma-separated file patterns to skip | ❌ | `*.lock,*.min.js,...` |
| `custom-prompt` | Extra instructions for the AI | ❌ | — |
| `post-as-review` | Post as PR review vs comment | ❌ | `false` |
| `temperature` | AI temperature (0.0–2.0) | ❌ | `0.3` |

### Outputs

| Output | Description |
|--------|-------------|
| `review` | The generated review text |

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
      - Proper use of React Server Components
```

### Only Review Source Code

```yaml
- uses: mikl-shortcuts/Pollinations-PR-Reviewer@v1
  with:
    pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    exclude-files: "*.lock,*.json,*.md,*.txt,*.yml,*.yaml,docs/**,*.svg,*.png,*.jpg"
```

### On-Demand Only (No Auto-Review)

```yaml
name: AI PR Review
on:
  issue_comment:
    types: [created]
permissions:
  contents: read
  pull-requests: write
  issues: write
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

### Use Review Output in Next Steps

```yaml
steps:
  - id: ai-review
    uses: mikl-shortcuts/Pollinations-PR-Reviewer@v1
    with:
      pollinations-api-key: ${{ secrets.POLLINATIONS_API_KEY }}
      github-token: ${{ secrets.GITHUB_TOKEN }}
  - name: Print review length
    run: echo "Review length: ${#REVIEW}"
    env:
      REVIEW: ${{ steps.ai-review.outputs.review }}
```

---

## API Key Types

| Type | Prefix | Use Case | Rate Limit |
|------|--------|----------|------------|
| Secret | `sk_` | Server-side (recommended for Actions) | None |
| Publishable | `pk_` | Client-side apps | 1 pollen/IP/hour |

**Recommendation:** Use a `sk_` (secret) key stored as a GitHub secret. Never commit API keys to your repo.

---

## FAQ

**Where do I get an API key?**
Go to [enter.pollinations.ai](https://enter.pollinations.ai), sign in, and create a key.

**How much does it cost?**
Each review consumes Pollen from your balance. Cost depends on the model and diff size. Check your balance at `gen.pollinations.ai/account/balance`.

**What models can I use?**
Any model listed at [gen.pollinations.ai/v1/models](https://gen.pollinations.ai/v1/models). Common options: `openai`, `mistral`.

**Is my code sent to a third party?**
The PR diff is sent to Pollinations AI (`gen.pollinations.ai`) for analysis. Don't use this on repos with code you can't share externally.

**What about large PRs?**
Diffs exceeding `max-diff-length` are automatically truncated. The AI reviews what fits. Keep PRs small for best results.

**The review didn't appear — what happened?**
Check the Actions tab in your repo for error logs. Common issues:
- Invalid API key
- Insufficient pollen balance
- Missing `permissions` in workflow file
- Very large diffs timing out

**Can I use this in a private repo?**
Yes. GitHub Actions has a free tier for private repos. Just be aware the diff is sent to Pollinations.

---

## Development

```bash
git clone https://github.com/mikl-shortcuts/Pollinations-PR-Reviewer.git
cd pollinations-pr-reviewer
npm install
npm run build
```

```bash
git add -A
git commit -m "v1.0.0"
git tag -a v1 -m "v1.0.0"
git push origin main --tags
```