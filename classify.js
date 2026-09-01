import 'dotenv/config';
import fetch from "node-fetch";
import OpenAI from "openai";
import fs from 'fs/promises';
import { normalizeTag, similarity } from './tag-utils.js';

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
      this.buildAliasIndex();
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
    return normalizeTag(tag);
  }

  /**
   * Build a lookup from any known spelling of a tag to its canonical form.
   *
   * registry.aliases is keyed by the raw variant ("Venture Capital"), but tags
   * arriving from the model are normalized first, so a straight key lookup
   * missed every alias -- which is why the 393-entry alias map was written each
   * week and never actually used to resolve anything.
   */
  buildAliasIndex() {
    this.aliasIndex = new Map();
    for (const [variant, canonical] of Object.entries(this.registry.aliases || {})) {
      this.aliasIndex.set(variant, canonical);
      this.aliasIndex.set(normalizeTag(variant), canonical);
    }
  }

  /** Follow aliases to the canonical tag, tolerating a malformed alias cycle. */
  resolve(tag) {
    if (!this.aliasIndex) this.buildAliasIndex();

    let current = tag;
    const seen = new Set();
    while (this.aliasIndex.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.aliasIndex.get(current);
    }
    return normalizeTag(current) || current;
  }

  /**
   * Tags that look similar to this one. Used only to report near-misses -- it
   * is NOT a merge decision. Edit distance measures string shape, not meaning:
   * it would happily merge "space"/"spaces" while missing
   * "crypto"/"cryptocurrency" entirely. Real merging is the cleanup script's
   * job, where a model judges meaning and every merge is recorded and
   * reversible.
   */
  findSimilarTags(tag, threshold = 0.8) {
    const normalized = normalizeTag(tag);
    return Object.keys(this.registry.tags)
      .filter(existing => existing !== normalized)
      .map(existing => ({ tag: existing, similarity: similarity(normalized, existing) }))
      .filter(({ similarity: s }) => s >= threshold)
      .sort((a, b) => b.similarity - a.similarity);
  }

  addTag(tag, category) {
    const normalized = normalizeTag(tag);
    if (!normalized) return normalized;

    if (this.registry.tags[normalized]) {
      this.registry.tags[normalized].usageCount++;
      // Backfill the real collection name over the historical 'general'.
      if (category && this.registry.tags[normalized].category === 'general') {
        this.registry.tags[normalized].category = category;
      }
    } else {
      this.registry.tags[normalized] = {
        category,
        usageCount: 1,
        firstUsed: new Date().toISOString(),
        variants: [],
      };
    }

    return normalized;
  }

  processAITags(aiTags, category) {
    const processed = [];

    for (const tag of aiTags) {
      const normalized = normalizeTag(tag);
      if (!normalized) continue;

      // An alias is a decision the cleanup already made and applied to the
      // library, so honour it before considering the tag new.
      const canonical = this.resolve(normalized);
      if (canonical !== normalized) {
        console.log(`\u{1F500} Alias "${tag}" \u2192 "${canonical}"`);
      }

      processed.push(this.addTag(canonical, category));
    }

    return processed.filter(Boolean);
  }

  getPopularTags(limit = 10) {
    return Object.entries(this.registry.tags)
      .sort(([,a], [,b]) => b.usageCount - a.usageCount)
      .slice(0, limit)
      .map(([tag, data]) => ({ tag, count: data.usageCount }));
  }

  getPopularTagsByCategory(category, limit = 10) {
    return Object.entries(this.registry.tags)
      .filter(([, data]) => data.category === category)
      .sort(([,a], [,b]) => b.usageCount - a.usageCount)
      .slice(0, limit)
      .map(([tag, data]) => ({ tag, count: data.usageCount }));
  }

  getCombinedTagContext(category, globalLimit = 8, categoryLimit = 7) {
    const globalTags = this.getPopularTags(globalLimit);
    const categoryTags = this.getPopularTagsByCategory(category, categoryLimit);
    
    // Remove duplicates, prefer category-specific tags
    const categoryTagNames = new Set(categoryTags.map(t => t.tag));
    const uniqueGlobalTags = globalTags.filter(t => !categoryTagNames.has(t.tag));
    
    return {
      categoryTags,
      globalTags: uniqueGlobalTags,
      combined: [...categoryTags, ...uniqueGlobalTags]
    };
  }
}

// Detect content type from URL and title
function detectContentType(bookmark) {
  const { title = '', link = '', excerpt = '' } = bookmark;
  const titleLower = title.toLowerCase();
  const linkLower = link.toLowerCase();
  const textContent = `${titleLower} ${excerpt}`.toLowerCase();
  
  // Tool/Software detection
  if (linkLower.includes('github.com') || 
      linkLower.includes('tools.') ||
      titleLower.includes('tool') ||
      titleLower.includes('app') ||
      titleLower.includes('software') ||
      textContent.includes('download') ||
      textContent.includes('install')) {
    return 'tool';
  }
  
  // Tutorial/Guide detection
  if (titleLower.includes('tutorial') ||
      titleLower.includes('guide') ||
      titleLower.includes('how to') ||
      titleLower.includes('step by step') ||
      titleLower.includes('walkthrough') ||
      textContent.includes('learn') ||
      textContent.includes('beginner')) {
    return 'tutorial';
  }
  
  // Video detection
  if (linkLower.includes('youtube.com') ||
      linkLower.includes('vimeo.com') ||
      linkLower.includes('twitch.tv') ||
      titleLower.includes('video') ||
      titleLower.includes('watch') ||
      titleLower.includes('episode')) {
    return 'video';
  }
  
  // Documentation detection
  if (linkLower.includes('docs.') ||
      linkLower.includes('/docs/') ||
      linkLower.includes('documentation') ||
      titleLower.includes('documentation') ||
      titleLower.includes('reference') ||
      titleLower.includes('api') ||
      textContent.includes('official docs')) {
    return 'documentation';
  }
  
  // News/Article detection (default)
  return 'article';
}

// Get content-specific tag instructions
function getContentTypeInstructions(contentType) {
  const instructions = {
    article: 'Focus on topic, publication, and subject matter tags',
    tool: 'Include "tool" or "software" tag plus functionality and technology tags',
    tutorial: 'Add "tutorial" or "guide" tag plus skill level and technology tags',
    video: 'Include "video" tag plus platform, topic, and format tags',
    documentation: 'Add "docs" or "reference" tag plus technology and purpose tags'
  };
  
  return instructions[contentType] || instructions.article;
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

// Ask GPT to suggest a category + tags (two-pass approach)
async function classifyBookmark(bookmark, tagManager) {
  await tagManager.loadTags();
  
  // First pass: Detect category and content type
  const contentType = detectContentType(bookmark);
  const contentInstructions = getContentTypeInstructions(contentType);
  
  const categoryPrompt = `Classify the following bookmark into one of these categories:
${Object.keys(COLLECTIONS).join(", ")}

Bookmark:
- Title: ${bookmark.title}
- Excerpt: ${bookmark.excerpt || "N/A"}
- Link: ${bookmark.link}
- Content Type: ${contentType}

Return JSON only:
{"category": "..."}`;

  const categoryResp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: categoryPrompt }],
    response_format: { type: "json_object" },
  });

  const { category } = JSON.parse(categoryResp.choices[0].message.content);
  
  // Second pass: Get dynamic tag context and generate tags
  const tagContext = tagManager.getCombinedTagContext(category);
  const categoryTagsList = tagContext.categoryTags.map(t => `${t.tag} (${t.count}×)`).join(", ");
  const globalTagsList = tagContext.globalTags.map(t => `${t.tag} (${t.count}×)`).join(", ");
  
  const tagPrompt = `Generate tags for this ${contentType} in the "${category}" category:

Bookmark:
- Title: ${bookmark.title}
- Excerpt: ${bookmark.excerpt || "N/A"}
- Link: ${bookmark.link}

${categoryTagsList ? `Popular tags in "${category}": ${categoryTagsList}

` : ''}${globalTagsList ? `Popular global tags: ${globalTagsList}

` : ''}Content-Specific Guidance: ${contentInstructions}

Tag Guidelines:
- Use 3-5 tags per bookmark (prefer 3-4 unless content is very broad)
- Use lowercase with hyphens (e.g., "machine-learning", "web-development")
- Prioritize reusing existing popular tags when relevant
- Keep tags concise and descriptive
- Avoid redundant or overly generic tags
- ${contentType === 'tool' ? 'Include functionality and technology tags' : ''}
- ${contentType === 'tutorial' ? 'Include skill level and learning-related tags' : ''}
- ${contentType === 'video' ? 'Include platform and format tags' : ''}

Good examples: ["react", "frontend", "tutorial"] or ["ai", "machine-learning", "tool"]
Avoid: ["general", "interesting", "good", "useful"]

Return JSON only:
{"tags": ["tag1", "tag2", "tag3"]}`;

  const tagResp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: tagPrompt }],
    response_format: { type: "json_object" },
  });

  const { tags } = JSON.parse(tagResp.choices[0].message.content);
  
  // Process tags through TagManager
  const processedTags = tagManager.processAITags(tags || [], category);
  await tagManager.saveTags();
  
  return { category, tags: processedTags, contentType };
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

    const { category, tags, contentType } = await classifyBookmark(bookmark, tagManager);

    console.log(` → Content type: ${contentType}`);
    console.log(` → Category: ${category}`);
    console.log(` → Tags: ${tags.join(", ")}\n`);

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