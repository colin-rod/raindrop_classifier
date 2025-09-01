import 'dotenv/config';
import fetch from "node-fetch";
import OpenAI from "openai";
import fs from 'fs/promises';

const RAINDROP_TOKEN = process.env.RAINDROP_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// Your existing collection mappings
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

// Fetch all bookmarks with tags from all collections
async function fetchAllBookmarksWithTags() {
  const allBookmarks = [];
  
  // Fetch from each collection
  for (const [categoryName, collectionId] of Object.entries(COLLECTIONS)) {
    console.log(`📂 Fetching bookmarks from ${categoryName}...`);
    
    let page = 0;
    const perpage = 50;
    
    while (true) {
      const resp = await fetch(`https://api.raindrop.io/rest/v1/raindrops/${collectionId}?perpage=${perpage}&page=${page}`, {
        headers: { Authorization: `Bearer ${RAINDROP_TOKEN}` },
      });

      if (!resp.ok) throw new Error(`Failed to fetch from collection ${collectionId}`);
      const data = await resp.json();

      if (data.items.length === 0) break;
      
      // Add category info to each bookmark
      const bookmarksWithCategory = data.items.map(bookmark => ({
        ...bookmark,
        currentCategory: categoryName
      }));
      
      allBookmarks.push(...bookmarksWithCategory);
      page++;
    }
  }

  return allBookmarks;
}

// Extract all unique tags from bookmarks
function extractAllTags(bookmarks) {
  const tagSet = new Set();
  const tagUsage = new Map();
  
  bookmarks.forEach(bookmark => {
    if (bookmark.tags && bookmark.tags.length > 0) {
      bookmark.tags.forEach(tag => {
        tagSet.add(tag);
        tagUsage.set(tag, (tagUsage.get(tag) || 0) + 1);
      });
    }
  });
  
  return { uniqueTags: Array.from(tagSet), tagUsage };
}

// Use AI to group similar tags and suggest consolidation
async function analyzeTagGroups(tags, batchSize = 20) {
  console.log(`🤖 Analyzing ${tags.length} tags for consolidation...`);
  
  const consolidationGroups = [];
  
  // Process tags in batches to avoid overwhelming the AI
  for (let i = 0; i < tags.length; i += batchSize) {
    const batch = tags.slice(i, i + batchSize);
    
    const prompt = `Analyze these tags and group similar ones together:

Tags: ${batch.join(", ")}

Find groups of tags that mean the same thing or are very similar. For each group, suggest the best canonical name.

Examples:
- ["js", "javascript", "javascript-lang"] → canonical: "javascript"
- ["ml", "machine-learning", "machine learning"] → canonical: "machine-learning"
- ["react", "reactjs", "react-js"] → canonical: "react"

Return JSON:
{
  "groups": [
    {
      "canonical": "javascript",
      "variants": ["js", "javascript", "javascript-lang"],
      "reason": "All refer to the JavaScript programming language"
    }
  ],
  "standalone": ["unique-tag1", "unique-tag2"]
}

Include standalone tags that don't have similar variants.`;

    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(resp.choices[0].message.content);
    consolidationGroups.push(...result.groups);
    
    console.log(`📊 Processed batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(tags.length/batchSize)}`);
    
    // Rate limiting
    await new Promise(r => setTimeout(r, 1000));
  }
  
  return consolidationGroups;
}

// Create tag mapping (old tag → new canonical tag)
function createTagMapping(consolidationGroups) {
  const mapping = new Map();
  
  consolidationGroups.forEach(group => {
    group.variants.forEach(variant => {
      if (variant !== group.canonical) {
        mapping.set(variant, group.canonical);
      }
    });
  });
  
  return mapping;
}

// Update bookmarks with consolidated tags
async function updateBookmarksWithCleanTags(bookmarks, tagMapping) {
  console.log(`🔄 Updating ${bookmarks.length} bookmarks with cleaned tags...`);
  
  let updatedCount = 0;
  
  for (const bookmark of bookmarks) {
    if (!bookmark.tags || bookmark.tags.length === 0) continue;
    
    // Map old tags to new canonical tags
    const newTags = bookmark.tags
      .map(tag => tagMapping.get(tag) || tag)
      .filter((tag, index, array) => array.indexOf(tag) === index); // Remove duplicates
    
    // Only update if tags changed
    if (JSON.stringify(bookmark.tags.sort()) !== JSON.stringify(newTags.sort())) {
      const resp = await fetch(`https://api.raindrop.io/rest/v1/raindrop/${bookmark._id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RAINDROP_TOKEN}`,
        },
        body: JSON.stringify({
          tags: newTags,
        }),
      });

      if (resp.ok) {
        console.log(`✅ Updated "${bookmark.title}"`);
        console.log(`   Old tags: [${bookmark.tags.join(", ")}]`);
        console.log(`   New tags: [${newTags.join(", ")}]\n`);
        updatedCount++;
      } else {
        console.error(`❌ Failed to update "${bookmark.title}"`);
      }
      
      // Rate limiting
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  return updatedCount;
}

// Save the tag registry for future use
async function saveTagRegistry(consolidationGroups, tagUsage) {
  const registry = {
    tags: {},
    aliases: {},
    lastUpdated: new Date().toISOString()
  };
  
  // Add canonical tags
  consolidationGroups.forEach(group => {
    registry.tags[group.canonical] = {
      category: 'general', // You can enhance this later
      usageCount: group.variants.reduce((sum, variant) => sum + (tagUsage.get(variant) || 0), 0),
      firstUsed: new Date().toISOString(),
      variants: group.variants
    };
    
    // Add aliases
    group.variants.forEach(variant => {
      if (variant !== group.canonical) {
        registry.aliases[variant] = group.canonical;
      }
    });
  });
  
  await fs.writeFile('tag-registry.json', JSON.stringify(registry, null, 2));
  console.log('💾 Saved tag registry to tag-registry.json');
}

async function main() {
  console.log('🧹 Starting one-time tag cleanup...\n');
  
  // Step 1: Fetch all bookmarks
  console.log('📥 Fetching all bookmarks with tags...');
  const bookmarks = await fetchAllBookmarksWithTags();
  console.log(`Found ${bookmarks.length} total bookmarks`);
  
  // Step 2: Extract and analyze tags
  const { uniqueTags, tagUsage } = extractAllTags(bookmarks);
  console.log(`Found ${uniqueTags.length} unique tags`);
  console.log(`Top 10 most used tags: ${Array.from(tagUsage.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => `${tag}(${count})`)
    .join(', ')}\n`);
  
  // Step 3: AI analysis for consolidation
  const consolidationGroups = await analyzeTagGroups(uniqueTags);
  
  // Step 4: Show consolidation plan
  console.log('\n📋 Consolidation Plan:');
  consolidationGroups.forEach(group => {
    if (group.variants.length > 1) {
      console.log(`🔗 "${group.canonical}" ← [${group.variants.filter(v => v !== group.canonical).join(', ')}]`);
      console.log(`   Reason: ${group.reason}\n`);
    }
  });
  
  // Step 5: Confirm before proceeding
  console.log(`\n⚠️  This will update ${bookmarks.filter(b => b.tags?.length > 0).length} bookmarks.`);
  console.log('Press Ctrl+C to cancel, or wait 10 seconds to proceed...\n');
  await new Promise(r => setTimeout(r, 10000));
  
  // Step 6: Create mapping and update bookmarks
  const tagMapping = createTagMapping(consolidationGroups);
  const updatedCount = await updateBookmarksWithCleanTags(bookmarks, tagMapping);
  
  // Step 7: Save registry for future use
  await saveTagRegistry(consolidationGroups, tagUsage);
  
  console.log(`\n✨ Cleanup complete!`);
  console.log(`📊 Updated ${updatedCount} bookmarks`);
  console.log(`🏷️  Consolidated ${tagMapping.size} duplicate tags`);
  console.log(`📁 Created tag registry with ${consolidationGroups.length} canonical tags`);
}

main().catch(err => console.error("❌ Error:", err));