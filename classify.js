import 'dotenv/config';
import fetch from "node-fetch";
import OpenAI from "openai";
import fs from 'fs/promises';

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

class TagManager {
  constructor() {
    this.tagRegistryPath = 'tag-registry.json';
    this.registry = {
      tags: {},
      aliases: {},
      lastUpdated: new Date().toISOString()
    };
  }

  async loadTags() {
    try {
      const data = await fs.readFile(this.tagRegistryPath, 'utf8');
      this.registry = JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('📝 Creating new tag registry...');
        await this.saveTags();
      } else {
        console.error('⚠️ Error loading tag registry:', error.message);
      }
    }
  }

  async saveTags() {
    try {
      this.registry.lastUpdated = new Date().toISOString();
      await fs.writeFile(this.tagRegistryPath, JSON.stringify(this.registry, null, 2));
    } catch (error) {
      console.error('⚠️ Error saving tag registry:', error.message);
    }
  }

  normalizeTag(tag) {
    return tag.toLowerCase()
      .replace(/[^a-z0-9\s&-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50);
  }

  levenshteinDistance(str1, str2) {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
    
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + cost
        );
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  findSimilarTags(tag, threshold = 0.8) {
    const normalizedTag = this.normalizeTag(tag);
    const similarTags = [];
    
    for (const existingTag in this.registry.tags) {
      const distance = this.levenshteinDistance(normalizedTag, existingTag);
      const maxLen = Math.max(normalizedTag.length, existingTag.length);
      const similarity = 1 - (distance / maxLen);
      
      if (similarity >= threshold && normalizedTag !== existingTag) {
        similarTags.push({ tag: existingTag, similarity });
      }
    }
    
    return similarTags.sort((a, b) => b.similarity - a.similarity);
  }

  addTag(tag, category) {
    const normalizedTag = this.normalizeTag(tag);
    if (!normalizedTag) return normalizedTag;
    
    if (this.registry.tags[normalizedTag]) {
      this.registry.tags[normalizedTag].usageCount++;
    } else {
      this.registry.tags[normalizedTag] = {
        category,
        usageCount: 1,
        firstUsed: new Date().toISOString()
      };
    }
    
    return normalizedTag;
  }

  processAITags(aiTags, category) {
    const processedTags = [];
    
    for (const tag of aiTags) {
      const normalizedTag = this.normalizeTag(tag);
      if (!normalizedTag) continue;
      
      // Check if tag already exists
      if (this.registry.tags[normalizedTag]) {
        processedTags.push(this.addTag(normalizedTag, category));
        continue;
      }
      
      // Check for similar tags
      const similarTags = this.findSimilarTags(normalizedTag);
      if (similarTags.length > 0) {
        const bestMatch = similarTags[0].tag;
        console.log(`🔀 Consolidating "${tag}" → "${bestMatch}"`);
        processedTags.push(this.addTag(bestMatch, category));
      } else {
        processedTags.push(this.addTag(normalizedTag, category));
      }
    }
    
    return processedTags.filter(Boolean);
  }

  getPopularTags(limit = 10) {
    return Object.entries(this.registry.tags)
      .sort(([,a], [,b]) => b.usageCount - a.usageCount)
      .slice(0, limit)
      .map(([tag, data]) => ({ tag, count: data.usageCount }));
  }
}

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
async function classifyBookmark(bookmark, tagManager) {
  await tagManager.loadTags();
  
  // Get popular tags to guide AI suggestions
  const popularTags = tagManager.getPopularTags(15);
  const popularTagsList = popularTags.map(t => t.tag).join(", ");
  
  const prompt = `Classify the following bookmark into one of these categories:
${Object.keys(COLLECTIONS).join(", ")}

Bookmark:
- Title: ${bookmark.title}
- Excerpt: ${bookmark.excerpt || "N/A"}
- Link: ${bookmark.link}

${popularTags.length > 0 ? `Popular existing tags to consider reusing: ${popularTagsList}

` : ''}Tag Guidelines:
- Use lowercase with hyphens (e.g., "machine-learning", "web-development")
- Reuse existing popular tags when possible
- Keep tags concise and descriptive
- Maximum 5 tags per bookmark

Return JSON only:
{"category": "...", "tags": ["tag1", "tag2"]}`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(resp.choices[0].message.content);
  
  // Process tags through TagManager
  if (parsed.tags && Array.isArray(parsed.tags)) {
    parsed.tags = tagManager.processAITags(parsed.tags, parsed.category);
    await tagManager.saveTags();
  }
  
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

  // Initialize TagManager
  const tagManager = new TagManager();
  await tagManager.loadTags();
  
  // Show current tag statistics
  const totalTags = Object.keys(tagManager.registry.tags).length;
  const popularTags = tagManager.getPopularTags(5);
  
  console.log(`📊 Tag Registry Stats:`);
  console.log(`   Total unique tags: ${totalTags}`);
  if (popularTags.length > 0) {
    console.log(`   Most popular: ${popularTags.map(t => `${t.tag} (${t.count}×)`).join(", ")}`);
  }
  console.log("");

  for (const bookmark of bookmarks) {
    console.log(`🔎 Classifying: ${bookmark.title}`);

    const { category, tags } = await classifyBookmark(bookmark, tagManager);

    console.log(` → Suggested category: ${category}`);
    console.log(` → Processed tags: ${tags.join(", ")}\n`);

    await updateBookmark(bookmark, category, tags);

    // Small delay to avoid hitting rate limits
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Final tag statistics
  const finalTags = Object.keys(tagManager.registry.tags).length;
  const newTagsCreated = finalTags - totalTags;
  
  console.log("✨ Done classifying all unsorted bookmarks!");
  console.log(`📊 Final Stats: ${finalTags} total tags (${newTagsCreated} new tags created)`);
}

main().catch(err => console.error("❌ Error:", err));