import OpenAI from "openai";
import sharp from "sharp";
import { google } from "googleapis";
import serviceAccount from "./meta-auto-489319-bf4f8f5a902c.json";

const SPREADSHEET_ID = "1RSAVO4AHtkwnEeZIRRGClnNIiB-BHzm9i9GxCc2Fv8E";

const sheetsAuth = new google.auth.JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth: sheetsAuth });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const FACEBOOK_TOKEN = process.env.FACEBOOK_GRAPH_API_KEY!;
const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID!;
const PORT = Number(process.env.PORT) || 8000;
const POST_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

let postCount = 0;
let lastPostTime: string | null = null;
let isPosting = false;
let postedTopics: Set<string> = new Set();

interface TrendingTopic {
  title: string;
  newsItems: { title: string; url: string; source: string }[];
  approximateTraffic: string;
}

async function fetchTrendingTopics(): Promise<TrendingTopic[]> {
  console.log(`[Trends] Fetching trending topics from Google Trends...`);

  const res = await fetch(
    "https://trends.google.com/trending/rss?geo=US",
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

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "You write short, punchy news headlines for thumbnail images. Return ONLY the headline text, nothing else.",
      },
      {
        role: "user",
        content: `Write a short, impactful news headline (max 8 words) for a thumbnail image about this trending topic:

Topic: ${topic.title}
Related: ${newsContext || "N/A"}

Rules:
- Maximum 8 words
- All uppercase
- Punchy and attention-grabbing
- No quotes, no hashtags, no punctuation except ? or !
- Return ONLY the headline`,
      },
    ],
    max_tokens: 50,
  });

  return response.choices[0]?.message?.content?.trim() || topic.title.toUpperCase();
}

async function generateNewsImage(topic: TrendingTopic, headline: string): Promise<Buffer> {
  console.log(`[Image] Generating news background for: "${topic.title}"`);

  // Generate a cinematic background image related to the topic
  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt: `Professional cinematic news photograph related to "${topic.title}". Dramatic lighting, photojournalism style, no text, no words, no letters, no watermarks. Wide shot, high quality, editorial photography style, moody atmosphere, suitable as a news broadcast background.`,
    n: 1,
    size: "1792x1024",
    quality: "hd",
    style: "natural",
  });

  const imageUrl = response.data?.[0]?.url;
  if (!imageUrl) throw new Error("No image URL returned from DALL-E");

  // Download the generated background
  console.log(`[Image] Downloading background...`);
  const imageRes = await fetch(imageUrl);
  const bgBuffer = Buffer.from(await imageRes.arrayBuffer());

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

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a news Facebook page content creator. Write engaging, informative posts about trending topics.",
      },
      {
        role: "user",
        content: `Write an engaging Facebook post about this trending topic.

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
      },
    ],
    max_tokens: 500,
  });

  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("No content returned from OpenAI");
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

async function saveToSheet(postId: string, topic: string, caption: string) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:D",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[postId, topic, caption, new Date().toISOString()]],
    },
  });
  console.log(`[Sheet] Post saved to Google Sheet`);
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

    // Generate headline, caption, image, and get page token in parallel
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

    await saveToSheet(postId, topic.title, caption);

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
