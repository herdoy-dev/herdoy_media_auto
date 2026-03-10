import sharp from "sharp";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const PEXELS_API_KEY = process.env.PIXELS_API_KEY!;
const FACEBOOK_TOKEN = process.env.FACEBOOK_GRAPH_API!;
const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID!;
const PORT = Number(process.env.PORT) || 8000;
const POST_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const OPENAI_MODEL = "gpt-4o-mini";
const RETRY_DELAY_MS = 30_000; // 30 seconds

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openaiGenerateText(systemPrompt: string, userPrompt: string, maxTokens: number = 500): Promise<string> {
  while (true) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: maxTokens,
        }),
      });
      const data = (await res.json()) as any;
      if (res.status === 429) {
        console.warn(`[OpenAI] Rate limited, retrying in 30 seconds...`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      if (data?.error) {
        console.warn(`[OpenAI] Error: ${data.error.message}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) {
        console.warn(`[OpenAI] No content in response, retrying...`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return text;
    } catch (err: any) {
      console.warn(`[OpenAI] Request failed: ${err.message}, retrying in 30 seconds...`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function pexelsSearchImage(query: string): Promise<Buffer> {
  while (true) {
    try {
      const res = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=15&orientation=landscape`,
        {
          headers: {
            "Authorization": PEXELS_API_KEY,
          },
        },
      );
      const data = (await res.json()) as any;
      if (res.status === 429) {
        console.warn(`[Pexels] Rate limited, retrying in 30 seconds...`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      if (!data?.photos?.length) {
        console.warn(`[Pexels] No photos found for "${query}", trying broader search...`);
        // Try a broader search with just the first word
        const broader = query.split(" ").slice(0, 2).join(" ");
        if (broader !== query) {
          const res2 = await fetch(
            `https://api.pexels.com/v1/search?query=${encodeURIComponent(broader)}&per_page=15&orientation=landscape`,
            { headers: { "Authorization": PEXELS_API_KEY } },
          );
          const data2 = (await res2.json()) as any;
          if (data2?.photos?.length) {
            const photo = data2.photos[Math.floor(Math.random() * data2.photos.length)];
            const imageUrl = photo.src.large2x || photo.src.large || photo.src.original;
            const imgRes = await fetch(imageUrl);
            return Buffer.from(await imgRes.arrayBuffer());
          }
        }
        // Fallback to "news" search
        const fallbackRes = await fetch(
          `https://api.pexels.com/v1/search?query=news+breaking&per_page=10&orientation=landscape`,
          { headers: { "Authorization": PEXELS_API_KEY } },
        );
        const fallbackData = (await fallbackRes.json()) as any;
        if (fallbackData?.photos?.length) {
          const photo = fallbackData.photos[Math.floor(Math.random() * fallbackData.photos.length)];
          const imageUrl = photo.src.large2x || photo.src.large || photo.src.original;
          const imgRes = await fetch(imageUrl);
          return Buffer.from(await imgRes.arrayBuffer());
        }
        console.warn(`[Pexels] Still no photos found, retrying in 30 seconds...`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      // Pick a random photo from results for variety
      const photo = data.photos[Math.floor(Math.random() * data.photos.length)];
      const imageUrl = photo.src.large2x || photo.src.large || photo.src.original;
      console.log(`[Pexels] Found photo by ${photo.photographer}: ${imageUrl}`);
      const imgRes = await fetch(imageUrl);
      return Buffer.from(await imgRes.arrayBuffer());
    } catch (err: any) {
      console.warn(`[Pexels] Request failed: ${err.message}, retrying in 30 seconds...`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

let postCount = 0;
let lastPostTime: string | null = null;
let isPosting = false;
let postedTopics: Set<string> = new Set();

interface TrendingTopic {
  title: string;
  newsItems: { title: string; url: string; source: string }[];
  approximateTraffic: string;
}

// Google Trends category IDs for diverse content
const TREND_CATEGORIES = [
  { id: "", label: "All" },
  { id: "&cat=e", label: "Entertainment" },
  { id: "&cat=b", label: "Business" },
  { id: "&cat=t", label: "Sci/Tech" },
  { id: "&cat=h", label: "Health" },
];
let currentCategoryIndex = 0;

async function fetchTrendingTopics(): Promise<TrendingTopic[]> {
  const category = TREND_CATEGORIES[currentCategoryIndex]!;
  currentCategoryIndex = (currentCategoryIndex + 1) % TREND_CATEGORIES.length;
  console.log(`[Trends] Fetching trending topics (${category.label})...`);

  const res = await fetch(
    `https://trends.google.com/trending/rss?geo=US${category.id}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    },
  );

  if (!res.ok) {
    throw new Error(`Google Trends RSS returned ${res.status}`);
  }

  const xml = await res.text();
  const topics: TrendingTopic[] = [];

  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1]!;

    const title = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
      itemXml.match(/<title>(.*?)<\/title>/)?.[1] || "";

    const traffic =
      itemXml.match(
        /<ht:approx_traffic>(.*?)<\/ht:approx_traffic>/,
      )?.[1] || "";

    const newsItems: { title: string; url: string; source: string }[] = [];
    const newsRegex =
      /<ht:news_item>([\s\S]*?)<\/ht:news_item>/g;
    let newsMatch;
    while ((newsMatch = newsRegex.exec(itemXml)) !== null) {
      const newsXml = newsMatch[1]!;
      const newsTitle =
        newsXml.match(
          /<ht:news_item_title><!\[CDATA\[(.*?)\]\]><\/ht:news_item_title>/,
        )?.[1] ||
        newsXml.match(/<ht:news_item_title>(.*?)<\/ht:news_item_title>/)?.[1] ||
        "";
      const newsUrl =
        newsXml.match(/<ht:news_item_url>(.*?)<\/ht:news_item_url>/)?.[1] || "";
      const newsSource =
        newsXml.match(
          /<ht:news_item_source>(.*?)<\/ht:news_item_source>/,
        )?.[1] || "";
      if (newsTitle) {
        newsItems.push({ title: newsTitle, url: newsUrl, source: newsSource });
      }
    }

    if (title) {
      topics.push({ title, newsItems, approximateTraffic: traffic });
    }
  }

  console.log(`[Trends] Found ${topics.length} trending topics`);
  return topics;
}

function pickNewTopic(topics: TrendingTopic[]): TrendingTopic | null {
  for (const topic of topics) {
    if (!postedTopics.has(topic.title.toLowerCase())) {
      return topic;
    }
  }
  if (topics.length > 0) {
    console.log(`[Trends] All topics posted, clearing history`);
    postedTopics.clear();
    return topics[0]!;
  }
  return null;
}

async function generateHeadline(topic: TrendingTopic): Promise<string> {
  const newsContext = topic.newsItems
    .map((n) => `- ${n.title} (${n.source})`)
    .join("\n");

  try {
    const text = await openaiGenerateText(
      "You write short, punchy news headlines for thumbnail images. Return ONLY the headline text, nothing else.",
      `Write a short, impactful news headline (max 8 words) for a thumbnail image about this trending topic:

Topic: ${topic.title}
Related: ${newsContext || "N/A"}

Rules:
- Maximum 8 words
- All uppercase
- Punchy and attention-grabbing
- No quotes, no hashtags, no punctuation except ? or !
- Return ONLY the headline`,
      50,
    );
    return text;
  } catch {
    return topic.title.toUpperCase();
  }
}

async function generateImageSearchQuery(topic: TrendingTopic): Promise<string> {
  try {
    const text = await openaiGenerateText(
      "You generate short search queries for stock photo websites. Return ONLY the search query, nothing else.",
      `Generate a 2-4 word search query to find a relevant stock photo for this news topic: "${topic.title}".
Return ONLY the search query, no quotes, no explanation.`,
      20,
    );
    return text.replace(/["']/g, "").trim();
  } catch {
    return topic.title;
  }
}

async function generateNewsImage(topic: TrendingTopic, headline: string): Promise<Buffer> {
  console.log(`[Image] Searching for news background for: "${topic.title}"`);

  // Generate a search query and fetch a photo from Pexels
  const searchQuery = await generateImageSearchQuery(topic);
  console.log(`[Image] Pexels search query: "${searchQuery}"`);
  const bgBuffer = await pexelsSearchImage(searchQuery);
  console.log(`[Image] Background fetched (${(bgBuffer.length / 1024).toFixed(0)} KB)`);

  // Create the news thumbnail overlay with SVG
  console.log(`[Image] Compositing headline overlay...`);
  const width = 1792;
  const height = 1024;

  // Word wrap the headline
  const words = headline.split(" ");
  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    const test = currentLine ? `${currentLine} ${word}` : word;
    if (test.length > 28) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = test;
    }
  }
  if (currentLine) lines.push(currentLine);

  const lineHeight = 72;
  const totalTextHeight = lines.length * lineHeight;
  const padding = 50;
  const barHeight = totalTextHeight + padding * 2 + 80;
  const barY = height - barHeight;

  // Build SVG text lines
  const textLines = lines
    .map((line, i) => {
      const y = barY + padding + 50 + i * lineHeight;
      const escaped = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<text x="${padding + 20}" y="${y}" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="58" font-weight="900" fill="white" letter-spacing="1">${escaped}</text>`;
    })
    .join("\n");

  // "TRENDING NOW" tag and date
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toUpperCase();
  const tagY = barY + padding - 5;

  const overlaySvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0)" />
      <stop offset="30%" stop-color="rgba(0,0,0,0.3)" />
      <stop offset="100%" stop-color="rgba(0,0,0,0.92)" />
    </linearGradient>
  </defs>
  <!-- Dark gradient overlay on bottom -->
  <rect x="0" y="${barY - 120}" width="${width}" height="${barHeight + 120}" fill="url(#grad)" />
  <!-- Red accent bar -->
  <rect x="${padding}" y="${tagY - 28}" width="200" height="36" rx="4" fill="#E50914" />
  <text x="${padding + 12}" y="${tagY - 1}" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="bold" fill="white" letter-spacing="2">TRENDING NOW</text>
  <!-- Headline text -->
  ${textLines}
  <!-- Date line -->
  <text x="${padding + 20}" y="${barY + padding + 50 + lines.length * lineHeight + 10}" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="rgba(255,255,255,0.7)" letter-spacing="1">${dateStr}</text>
  <!-- Top accent line -->
  <rect x="0" y="0" width="${width}" height="5" fill="#E50914" />
</svg>`;

  const overlayBuffer = Buffer.from(overlaySvg);

  // Composite the overlay on top of the background
  const finalImage = await sharp(bgBuffer)
    .resize(width, height, { fit: "cover" })
    .composite([{ input: overlayBuffer, top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();

  console.log(`[Image] News thumbnail created (${(finalImage.length / 1024).toFixed(0)} KB)`);
  return finalImage;
}

async function generateNewsPost(topic: TrendingTopic): Promise<string> {
  console.log(`[AI] Generating caption about: "${topic.title}"`);

  const newsContext = topic.newsItems
    .map((n) => `- ${n.title} (${n.source})`)
    .join("\n");

  const text = await openaiGenerateText(
    "You are a news Facebook page content creator. Write engaging, informative posts about trending topics.",
    `Write an engaging Facebook post about this trending topic.

Trending Topic: ${topic.title}
Approximate Search Traffic: ${topic.approximateTraffic}

Related Headlines:
${newsContext || "No specific headlines available"}

Rules:
- Write 3-5 sentences summarizing what's happening with this topic
- Make it informative and engaging for a general audience
- Include your analysis or interesting perspective
- Add 5-8 relevant hashtags at the end on a new line
- Do NOT use any emojis
- Do NOT include any URLs
- Write in a professional but approachable tone
- Start with a strong hook to grab attention`,
    500,
  );
  return text;
}

async function getPageAccessToken(): Promise<string> {
  const res = await fetch(
    `https://graph.facebook.com/v22.0/${FACEBOOK_PAGE_ID}?fields=access_token&access_token=${FACEBOOK_TOKEN}`,
  );
  const data = (await res.json()) as any;

  if (data.error) {
    console.warn(`[Page] Could not get page token: ${data.error.message}`);
    console.log(`[Page] Using provided token directly`);
    return FACEBOOK_TOKEN;
  }

  if (data.access_token) {
    console.log(`[Page] Got page-specific access token`);
    return data.access_token;
  }

  return FACEBOOK_TOKEN;
}

async function postToFacebook(
  pageId: string,
  pageAccessToken: string,
  imageBuffer: Buffer,
  caption: string,
): Promise<any> {
  console.log(`[Upload] Uploading image to Facebook...`);
  const formData = new FormData();
  formData.append(
    "source",
    new File([imageBuffer], "news.jpg", { type: "image/jpeg" }),
  );
  formData.append("message", caption);
  formData.append("access_token", pageAccessToken);

  const res = await fetch(`https://graph.facebook.com/v22.0/${pageId}/photos`, {
    method: "POST",
    body: formData,
  });
  const data = (await res.json()) as any;
  if (data.error) {
    throw new Error(`Facebook post error: ${data.error.message}`);
  }
  return data;
}

async function createAndPublishPost() {
  if (isPosting) {
    console.log("[Skip] Already posting, skipping this cycle");
    return;
  }
  isPosting = true;

  try {
    console.log(`\n${"=".repeat(50)}`);
    console.log(
      `[Post #${postCount + 1}] Starting at ${new Date().toLocaleString()}`,
    );

    // Fetch trending topics
    const topics = await fetchTrendingTopics();
    const topic = pickNewTopic(topics);
    if (!topic) {
      console.log("[Skip] No new trending topics found");
      return;
    }

    console.log(
      `[Topic] "${topic.title}" (${topic.approximateTraffic} searches)`,
    );

    // Generate headline, caption, and get page token in parallel
    const [headline, caption, pageAccessToken] = await Promise.all([
      generateHeadline(topic),
      generateNewsPost(topic),
      getPageAccessToken(),
    ]);

    console.log(`[Headline] ${headline}`);
    console.log(`[Caption] ${caption.substring(0, 100)}...`);

    // Generate the news thumbnail image (needs headline first)
    const imageBuffer = await generateNewsImage(topic, headline);

    const result = await postToFacebook(
      FACEBOOK_PAGE_ID,
      pageAccessToken,
      imageBuffer,
      caption,
    );
    postCount++;
    lastPostTime = new Date().toISOString();
    postedTopics.add(topic.title.toLowerCase());

    const postId = result.post_id || result.id;
    console.log(`[Success] Post published! Post ID: ${postId}`);
    console.log(`[Stats] Total posts: ${postCount}`);

    console.log(`[Next] Next post in 30 minutes`);
    console.log(`${"=".repeat(50)}\n`);
  } catch (error: any) {
    console.error(`[Error] Failed to create post: ${error.message}`);
  } finally {
    isPosting = false;
  }
}

// Start the auto-posting loop
console.log("Starting Facebook News Auto Poster...");
console.log(`Posting every ${POST_INTERVAL_MS / 60000} minutes`);

// Post immediately on start, then every 30 minutes
createAndPublishPost();
setInterval(createAndPublishPost, POST_INTERVAL_MS);

// HTTP server for status monitoring
Bun.serve({
  port: PORT,
  routes: {
    "/": new Response(
      JSON.stringify({ status: "Facebook News Auto Poster is running" }),
      { headers: { "Content-Type": "application/json" } },
    ),
    "/status": {
      GET: () => {
        return Response.json({
          status: "running",
          totalPosts: postCount,
          lastPostTime,
          nextPostIn: `${Math.round(POST_INTERVAL_MS / 60000)} minutes`,
          isCurrentlyPosting: isPosting,
          postedTopics: [...postedTopics],
          textModel: OPENAI_MODEL,
          imageSource: "Pexels",
          nextCategory: TREND_CATEGORIES[currentCategoryIndex]?.label,
        });
      },
    },
    "/post": {
      POST: async () => {
        createAndPublishPost();
        return Response.json({ message: "Manual post triggered" });
      },
    },
  },
});

console.log(`Status server running on http://localhost:${PORT}`);
console.log(`  GET  /        - Basic status`);
console.log(`  GET  /status  - Detailed status`);
console.log(`  POST /post    - Trigger manual post`);
