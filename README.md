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
npm run classify
```

### Automatic Schedule

The GitHub Actions workflow runs automatically daily at 3:00 AM UTC. You can also trigger it manually from the Actions tab in your GitHub repo.

## How It Works

1. Fetches all bookmarks from the "Unsorted" collection (-1)
2. For each bookmark, sends title, excerpt, and URL to GPT-4o-mini
3. AI suggests a category and relevant tags
4. Moves bookmark to the appropriate collection and applies tags
5. Includes rate limiting to avoid API limits

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