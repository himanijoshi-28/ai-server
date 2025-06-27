// server/index.js
const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors()); // Allow frontend to connect
app.use(express.json()); // To handle JSON body

// ✅ ROUTE: Get news based on keyword
app.get("/news", async (req, res) => {
  const keyword = req.query.keyword;

  if (!keyword) {
    return res.status(400).json({ error: "Keyword is required" });
  }

  try {
    const rssURL = `https://news.google.com/rss/search?q=${encodeURIComponent(
      keyword
    )}`;
    const response = await axios.get(rssURL);

    // Parse XML to JSON
    xml2js.parseString(response.data, (err, result) => {
      if (err) {
        console.error("XML Parse Error:", err);
        return res.status(500).json({ error: "Failed to parse RSS feed" });
      }

      // Check if articles exist
      if (
        !result.rss ||
        !result.rss.channel ||
        !result.rss.channel[0] ||
        !result.rss.channel[0].item
      ) {
        return res
          .status(404)
          .json({ error: "No articles found for this keyword" });
      }

      const items = result.rss.channel[0].item.slice(0, 5); // Top 5
      const articles = items.map((item) => ({
        title: item.title[0],
        link: item.link[0],
        pubDate: item.pubDate[0],
        description: item.description
          ? item.description[0]
          : "No description available",
      }));

      res.json({ articles });
    });
  } catch (error) {
    console.error("News fetch error:", error.message);
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

// ✅ ROUTE: Generate LinkedIn post using AI
app.post("/generate-post", async (req, res) => {
  const { articles } = req.body;

  if (!articles || !Array.isArray(articles) || articles.length === 0) {
    return res.status(400).json({ error: "Articles required" });
  }

  const content = articles
    .map((a, i) => `(${i + 1}) ${a.title} - ${a.description}`)
    .join("\n\n");

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "mistralai/mistral-7b-instruct",
        messages: [
          {
            role: "system",
            content:
              "You are an expert content writer who creates short, engaging, and opinionated LinkedIn posts based on recent news. Keep posts professional but engaging.",
          },
          {
            role: "user",
            content: `Here are some news articles:\n\n${content}\n\nGenerate a 5-7 line opinionated LinkedIn post. Start directly with an opinion. Keep it relevant, thoughtful, and professional. Use emojis sparingly.`,
          },
        ],
        temperature: 0.7,
        max_tokens: 300,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.HTTP_REFERER || "http://localhost:3000",
          "X-Title": "ai-newspost-generator",
        },
      }
    );

    const aiPost = response.data.choices[0].message.content.trim();
    res.json({ post: aiPost });
  } catch (error) {
    console.error("OpenRouter Error:", error.response?.data || error.message);
    res.status(500).json({
      error: "Failed to generate post",
      details: error.response?.data?.error || "AI service unavailable",
    });
  }
});

// ✅ ROUTE: Redirect to LinkedIn OAuth
app.get("/auth/linkedin", (req, res) => {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  // Only request posting permission - profile access is deprecated for new apps
  const scope = "w_member_social";

  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: "LinkedIn OAuth not configured" });
  }

  console.log("Initiating LinkedIn OAuth with scope:", scope);

  const authUrl =
    `https://www.linkedin.com/oauth/v2/authorization` +
    `?response_type=code&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}`;

  console.log("Redirecting to:", authUrl);
  res.redirect(authUrl);
});

// ✅ ROUTE: LinkedIn OAuth callback
app.get("/auth/linkedin/callback", async (req, res) => {
  const { code, error, error_description } = req.query;
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;

  console.log("LinkedIn callback received:", {
    code: !!code,
    error,
    error_description,
  });
  console.log("Full query params:", req.query);

  // Handle OAuth errors from LinkedIn
  if (error) {
    console.error("LinkedIn OAuth Error:", error, error_description);
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    return res.redirect(
      `${frontendUrl}?error=${encodeURIComponent(error_description || error)}`
    );
  }

  if (!code) {
    console.error("No authorization code received");
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    return res.redirect(`${frontendUrl}?error=Authorization code not provided`);
  }

  try {
    console.log("Requesting access token from LinkedIn...");
    const tokenRes = await axios.post(
      "https://www.linkedin.com/oauth/v2/accessToken",
      null,
      {
        params: {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const accessToken = tokenRes.data.access_token;
    console.log("Access token received successfully");

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(`${frontendUrl}?linkedin_token=${accessToken}`);
  } catch (err) {
    console.error("LinkedIn Auth Error:", err.response?.data || err.message);
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(
      `${frontendUrl}?error=${encodeURIComponent(
        "LinkedIn authentication failed"
      )}`
    );
  }
});

// ✅ ROUTE: Post to LinkedIn
app.post("/linkedin/post", async (req, res) => {
  const { token, content } = req.body;

  if (!token || !content) {
    return res.status(400).json({ error: "Token and content required" });
  }

  try {
    console.log("Posting to LinkedIn...");
    // Post to LinkedIn using UGC API without getting profile first
    // Use 'urn:li:person:me' which works with w_member_social scope
    const postResponse = await axios.post(
      "https://api.linkedin.com/v2/ugcPosts",
      {
        author: "urn:li:person:me",
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: content },
            shareMediaCategory: "NONE",
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Restli-Protocol-Version": "2.0.0",
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Post successful:", postResponse.data);
    res.json({ success: true, message: "Posted on LinkedIn!" });
  } catch (error) {
    console.error(
      "LinkedIn Post Error:",
      error.response?.data || error.message
    );
    res.status(500).json({
      error: "Failed to post on LinkedIn",
      details: error.response?.data?.message || "LinkedIn API error",
    });
  }
});

// ✅ Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
