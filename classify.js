import 'dotenv/config';
import fetch from "node-fetch";
import OpenAI from "openai";

const RAINDROP_TOKEN = process.env.RAINDROP_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// Map your categories to Raindrop collection IDs (after running create-collections.js)
const COLLECTIONS = {
  "AI & Technology": 59437707,
  "Entertainment & Media": 59437708,
  "Business & Startups": 59437709,
  "Career & Professional Development": 59437710,
  "Politics & Current Affairs": 59437711,
  "Lifestyle & Practical": 59437712,
  "Finance & Economics": 59437713,
  "Global & Cultural": 59437715,
  "Others": 59437777
};

// Fetch all unsorted bookmarks (from collection -1)
async function fetchAllUnsortedBookmarks() {
  let page = 0;
  const perpage = 50;
  let all = [];

  while (true) {
    // Changed from collection 0 to collection -1 (unsorted)
    const resp = await fetch(`https://api.raindrop.io/rest/v1/raindrops/-1?perpage=${perpage}&page=${page}`, {
      headers: { Authorization: `Bearer ${RAINDROP_TOKEN}` },
    });

    if (!resp.ok) throw new Error("Failed to fetch bookmarks");
    const data = await resp.json();

    if (data.items.length === 0) break; // no more results
    all = all.concat(data.items);

    page++;
  }

  // Additional filter to ensure we only get truly unsorted bookmarks
  return all.filter(bookmark => bookmark.collection.$id === -1);
}

// Ask GPT to suggest a category + tags
async function classifyBookmark(bookmark) {
  const prompt = `Classify the following bookmark into one of these categories:
${Object.keys(COLLECTIONS).join(", ")}

Bookmark:
- Title: ${bookmark.title}
- Excerpt: ${bookmark.excerpt || "N/A"}
- Link: ${bookmark.link}

Return JSON only:
{"category": "...", "tags": ["tag1", "tag2"]}`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(resp.choices[0].message.content);
  return parsed;
}

// Move + update the bookmark in Raindrop
async function updateBookmark(bookmark, category, tags) {
  const collectionId = COLLECTIONS[category];
  if (!collectionId) {
    console.error(`⚠️ No collection mapped for category "${category}", skipping...`);
    return;
  }

  const resp = await fetch(`https://api.raindrop.io/rest/v1/raindrop/${bookmark._id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RAINDROP_TOKEN}`,
    },
    body: JSON.stringify({
      collection: { $id: collectionId },
      tags,
    }),
  });

  if (!resp.ok) {
    console.error(`❌ Failed to update bookmark "${bookmark.title}"`, await resp.text());
  } else {
    console.log(`✅ Updated "${bookmark.title}" → ${category} [${tags.join(", ")}]`);
  }
}

async function main() {
  console.log("📥 Fetching unsorted bookmarks...");
  const bookmarks = await fetchAllUnsortedBookmarks();
  console.log("Collection IDs of fetched bookmarks:", [...new Set(bookmarks.map(b => b.collection.$id))]);

  if (!bookmarks.length) {
    console.log("🎉 No unsorted bookmarks left!");
    return;
  }

  console.log(`Found ${bookmarks.length} truly unsorted bookmarks.\n`);

  for (const bookmark of bookmarks) {
    console.log(`🔎 Classifying: ${bookmark.title}`);

    const { category, tags } = await classifyBookmark(bookmark);

    console.log(` → Suggested category: ${category}`);
    console.log(` → Suggested tags: ${tags.join(", ")}\n`);

    await updateBookmark(bookmark, category, tags);

    // Small delay to avoid hitting rate limits
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("✨ Done classifying all unsorted bookmarks!");
}

main().catch(err => console.error("❌ Error:", err));