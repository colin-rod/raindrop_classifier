# Raindrop Classifier

Automatically tags and categorizes your Raindrop.io bookmarks using OpenAI GPT-4o-mini.

## Features

- Fetches all unsorted bookmarks from Raindrop.io
- Uses AI to classify bookmarks into predefined categories
- Automatically adds relevant tags
- Moves bookmarks to appropriate collections
- Runs automatically on a schedule via GitHub Actions

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create a `.env` file with:

```
RAINDROP_TOKEN=your_raindrop_token_here
OPENAI_API_KEY=your_openai_api_key_here
```

Get your tokens from:
- `OPENAI_API_KEY`: https://platform.openai.com/
- `RAINDROP_TOKEN`: https://app.raindrop.io/settings/integrations

### 3. Configure Collections

Update the `COLLECTIONS` object in `classify.js` with your Raindrop collection IDs:

```javascript
const COLLECTIONS = {
  "AI & Technology": 59437707,
  "Entertainment & Media": 59437708,
  "Business & Startups": 59437709,
  // ... add your collection IDs
};
```

### 4. GitHub Actions Setup

1. Push this repo to GitHub
2. Go to Settings → Secrets and variables → Actions
3. Add these repository secrets:
   - `RAINDROP_TOKEN`
   - `OPENAI_API_KEY`

## Usage

### Manual Run

```bash
npm run classify          # tag and file unsorted bookmarks
npm run audit             # read-only report on the tag vocabulary
npm run audit -- --deep   # also walk every bookmark (untagged counts)
npm run cleanup           # consolidate duplicate tags
npm test                  # unit tests, no network required
```

### Automatic Schedule

The GitHub Actions workflow runs weekly on Sundays at 3:00 AM UTC, and can be
triggered manually from the Actions tab. It commits `tag-registry.json`,
`tag-metrics.json` and `tag-merge-log.json` back to the repo — without that the
registry resets to its last committed state on every run.

## How It Works

### Classification (`classify.js`)

1. Fetches all bookmarks from the "Unsorted" collection (-1)
2. For each bookmark, sends title, excerpt, and URL to GPT-4o-mini
3. AI suggests a category and relevant tags
4. Tags are normalized and resolved through the alias map, so a variant of an
   existing tag reuses it instead of creating a near-duplicate
5. Moves bookmark to the appropriate collection and applies tags
6. Includes rate limiting to avoid API limits

### Consolidation (`cleanup-existing-tags.js`)

Runs across **all** collections, not just the nine the classifier manages.

1. Reads the whole vocabulary with `GET /tags/0` — one call, exact counts
2. **Lexical pass** (deterministic, no model): merges tags that are identical
   once normalized, plus genuine singular/plural pairs. Guarded against plurals
   that change meaning, e.g. `new` is never merged into `news`
3. **Semantic pass**: asks the model to merge true synonyms only. Every prompt
   carries the full vocabulary, so a merge target can be any tag — not just one
   that happened to land in the same batch
4. Records per-bookmark provenance, then applies each merge with a single
   `PUT /tags/0`

Model output is advisory. Proposed merges naming tags that do not exist, merging
a tag into itself, or contradicting an earlier group are discarded before
anything is applied.

#### Safety

| Rail | Behaviour |
| --- | --- |
| `--dry-run` | Prints the merge plan and the exact API calls, writes nothing |
| `--revert <runId>` | Restores the bookmarks a run changed, and only those |
| Circuit breaker | Aborts a run that would merge over 40% of the vocabulary |

Reverting needs per-bookmark provenance rather than a rename back: once `AI` and
`ai` are both `ai`, the tags API cannot tell the two populations apart, so
renaming back would also rewrite bookmarks that always said `ai`. Each run
records which bookmarks carried which tag before merging, which is what
`tag-merge-log.json` is for.

### Repairing the registry (`repair-registry.js`)

A one-off, idempotent fix for a registry that predates the above: normalizes
malformed keys, resolves tags that were both canonical and an alias of something
else, and backfills missing fields. Run without arguments for a diff, `--write`
to apply.

## Categories

- AI & Technology
- Entertainment & Media
- Business & Startups
- Career & Professional Development
- Politics & Current Affairs
- Lifestyle & Practical
- Finance & Economics
- Global & Cultural
- Others

## Requirements

- Node.js 18+
- Raindrop.io API token
- OpenAI API key
- GitHub repository (for scheduled runs)