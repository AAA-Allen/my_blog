const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.set("trust proxy", true);
const PORT = Number(process.env.PORT || 4321);
const dataPath = path.join(__dirname, "data", "site-data.json");
const assetRoots = {
  images: path.join(__dirname, "..", "source", "images"),
  videos: path.join(__dirname, "..", "source", "videos"),
};

const pageMap = {
  "/": "home",
  "/archive": "archive",
  "/categories": "categories",
  "/tags": "tags",
  "/timeline": "timeline",
  "/about": "about",
  "/community": "community",
  "/admin": "admin",
};

function readData() {
  const raw = fs.readFileSync(dataPath, "utf8");
  return JSON.parse(raw);
}

function writeData(data) {
  fs.writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeText(value, maxLength = 500) {
  return String(value || "")
    .trim()
    .replace(/\r\n/g, "\n")
    .slice(0, maxLength);
}

function normalizeAuthor(input) {
  const name = sanitizeText(input && input.name, 24) || "旅人";
  const avatar = sanitizeText(input && input.avatar, 300) || "/images/avatar.jpg";
  return { name, avatar };
}

function ensureCommunityPosts(data) {
  if (!Array.isArray(data.communityPosts)) {
    data.communityPosts = [];
  }

  return data.communityPosts;
}

function ensureArticleComments(data) {
  if (!data.articleComments || typeof data.articleComments !== "object") {
    data.articleComments = {};
  }

  return data.articleComments;
}

function ensurePlayerStates(data) {
  if (!data.playerStates || typeof data.playerStates !== "object") {
    data.playerStates = {};
  }

  return data.playerStates;
}

function ensureArticles(data) {
  if (!Array.isArray(data.articles)) {
    data.articles = [];
  }

  return data.articles;
}

function ensurePlaylist(data) {
  if (!Array.isArray(data.playlist)) {
    data.playlist = [];
  }

  return data.playlist;
}

function readNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function slugify(value) {
  return sanitizeText(value, 120)
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\-\u4e00-\u9fa5]/g, "")
    .replace(/\-+/g, "-")
    .replace(/^-|-$/g, "");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeTagList(input) {
  const rawItems = Array.isArray(input) ? input : String(input || "").split(/[,\n]/);
  const seen = new Set();

  return rawItems
    .map((item) => sanitizeText(item, 20))
    .filter((item) => {
      if (!item || seen.has(item)) {
        return false;
      }

      seen.add(item);
      return true;
    })
    .slice(0, 10);
}

function normalizeArticlePayload(input, fallbackSlug) {
  const title = sanitizeText(input && input.title, 120);
  const content = String((input && input.content) || "").trim();

  if (!title) {
    return { error: "文章标题不能为空。" };
  }

  if (!content) {
    return { error: "文章正文不能为空。" };
  }

  const slug = slugify((input && input.slug) || title) || fallbackSlug || createId("article");
  const excerpt =
    sanitizeText(input && input.excerpt, 220) || sanitizeText(stripHtml(content), 220) || "这是一篇新的博客文章。";
  const category = sanitizeText(input && input.category, 40) || "未分类";
  const tags = sanitizeTagList(input && input.tags);
  const dateValue = sanitizeText(input && input.date, 40) || new Date().toISOString().slice(0, 10);
  const parsedDate = new Date(dateValue);

  if (Number.isNaN(parsedDate.getTime())) {
    return { error: "文章日期格式不正确。" };
  }

  return {
    value: {
      slug,
      title,
      excerpt,
      category,
      tags,
      date: parsedDate.toISOString().slice(0, 10),
      content,
    },
  };
}

function normalizeTrackNotes(input) {
  let notes = [];

  if (Array.isArray(input && input.notes)) {
    notes = input.notes;
  } else if (typeof (input && input.notesJson) === "string" && String(input.notesJson).trim()) {
    try {
      notes = JSON.parse(String(input.notesJson));
    } catch (_error) {
      return { error: "音符 JSON 格式不正确。" };
    }
  }

  if (!Array.isArray(notes)) {
    return { error: "音符数据必须是数组。" };
  }

  return {
    value: notes.slice(0, 160).map((note) => ({
      frequency: Math.max(0, readNumber(note && note.frequency, 0)),
      beats: Math.max(0.1, readNumber(note && note.beats, 0.5)),
    })),
  };
}

function normalizeTrackPayload(input, existingId) {
  const title = sanitizeText(input && input.title, 80);
  if (!title) {
    return { error: "歌曲名称不能为空。" };
  }

  const artist = sanitizeText(input && input.artist, 80) || "Unknown Artist";
  const subtitle = sanitizeText(input && input.subtitle, 140) || artist;
  const coverLabel = sanitizeText(input && input.coverLabel, 24) || title.slice(0, 8);
  const coverFrom = sanitizeText(input && input.coverFrom, 20) || "#6ea8ff";
  const coverTo = sanitizeText(input && input.coverTo, 20) || "#7267ff";
  const audioUrl = sanitizeText(input && input.audioUrl, 500);
  const bpm = Math.max(40, Math.min(220, Math.round(readNumber(input && input.bpm, 96))));
  const normalizedNotes = normalizeTrackNotes(input);

  if (normalizedNotes.error) {
    return normalizedNotes;
  }

  if (!audioUrl && !normalizedNotes.value.length) {
    return { error: "请提供音频链接，或者填写可解析的音符 JSON。" };
  }

  return {
    value: {
      id: sanitizeText(input && input.id, 80) || existingId || createId("track"),
      title,
      artist,
      subtitle,
      cover: {
        label: coverLabel,
        from: coverFrom,
        to: coverTo,
      },
      bpm,
      notes: normalizedNotes.value,
      audioUrl,
    },
  };
}

function ensureAnalytics(data) {
  if (!data.analytics || typeof data.analytics !== "object") {
    data.analytics = {};
  }

  if (!data.analytics.daily || typeof data.analytics.daily !== "object") {
    data.analytics.daily = {};
  }

  if (!data.analytics.sources || typeof data.analytics.sources !== "object") {
    data.analytics.sources = {};
  }

  if (!data.analytics.visitors || typeof data.analytics.visitors !== "object") {
    data.analytics.visitors = {};
  }

  if (!data.analytics.thirdParty || typeof data.analytics.thirdParty !== "object") {
    data.analytics.thirdParty = {};
  }

  data.analytics.pageViews = Math.max(
    0,
    readNumber(
      Object.prototype.hasOwnProperty.call(data.analytics, "pageViews") ? data.analytics.pageViews : data.site.viewBase,
      0
    )
  );
  data.analytics.uniqueVisitors = Math.max(
    0,
    readNumber(
      Object.prototype.hasOwnProperty.call(data.analytics, "uniqueVisitors")
        ? data.analytics.uniqueVisitors
        : data.site.visitorBase,
      0
    )
  );
  data.analytics.likeCount = Math.max(0, readNumber(data.analytics.likeCount, 0));
  data.analytics.commentCount = Math.max(0, readNumber(data.analytics.commentCount, 0));
  data.analytics.lastVisitAt =
    Object.prototype.hasOwnProperty.call(data.analytics, "lastVisitAt") ? data.analytics.lastVisitAt : data.site.updatedAt || null;
  data.analytics.thirdParty.provider = data.analytics.thirdParty.provider || "plausible";
  data.analytics.thirdParty.enabled = Boolean(data.analytics.thirdParty.enabled);
  data.analytics.thirdParty.domain = String(data.analytics.thirdParty.domain || "");
  data.analytics.thirdParty.scriptUrl = String(data.analytics.thirdParty.scriptUrl || "https://plausible.io/js/script.js");
  data.analytics.thirdParty.measurementId = String(data.analytics.thirdParty.measurementId || "");
  data.analytics.thirdParty.websiteId = String(data.analytics.thirdParty.websiteId || "");
  data.analytics.thirdParty.clarityId = String(data.analytics.thirdParty.clarityId || "");
  return data.analytics;
}

function ensureLikeTracking(item) {
  if (!Array.isArray(item.likedBy)) {
    item.likedBy = [];
  }

  return item.likedBy;
}

function hasLiked(item, fingerprint) {
  if (!fingerprint) {
    return false;
  }

  return ensureLikeTracking(item).includes(fingerprint);
}

function toggleLike(item, fingerprint) {
  const likedBy = ensureLikeTracking(item);
  const existingIndex = fingerprint ? likedBy.indexOf(fingerprint) : -1;

  if (existingIndex >= 0) {
    likedBy.splice(existingIndex, 1);
    item.likes = Math.max(0, Number(item.likes || 0) - 1);
    return {
      liked: false,
      likes: item.likes,
      delta: -1,
    };
  }

  if (fingerprint) {
    likedBy.push(fingerprint);
  }

  item.likes = Number(item.likes || 0) + 1;
  return {
    liked: true,
    likes: item.likes,
    delta: 1,
  };
}

function sortByCreatedAtDesc(items) {
  return items.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function paginateItems(items, page, limit) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (currentPage - 1) * limit;

  return {
    items: items.slice(startIndex, startIndex + limit),
    pagination: {
      page: currentPage,
      limit,
      total,
      totalPages,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages,
    },
  };
}

function cloneCommentBranch(item, fingerprint) {
  return {
    id: item.id,
    author: item.author,
    content: item.content,
    createdAt: item.createdAt,
    likes: Number(item.likes || 0),
    liked: hasLiked(item, fingerprint),
    replies: Array.isArray(item.replies) ? item.replies.map((reply) => cloneCommentBranch(reply, fingerprint)) : [],
  };
}

function getArticleComments(data, slug, fingerprint) {
  const articleComments = ensureArticleComments(data);
  const comments = Array.isArray(articleComments[slug]) ? articleComments[slug] : [];
  return sortByCreatedAtDesc(comments).map((item) => cloneCommentBranch(item, fingerprint));
}

function getCommunityPosts(data, fingerprint) {
  const posts = ensureCommunityPosts(data).map((post) => ({
    id: post.id,
    author: post.author,
    content: post.content,
    createdAt: post.createdAt,
    likes: Number(post.likes || 0),
    liked: hasLiked(post, fingerprint),
    comments: sortByCreatedAtDesc(Array.isArray(post.comments) ? post.comments : []).map((comment) => ({
      id: comment.id,
      author: comment.author,
      content: comment.content,
      createdAt: comment.createdAt,
      likes: Number(comment.likes || 0),
      liked: hasLiked(comment, fingerprint),
    })),
  }));

  return sortByCreatedAtDesc(posts);
}

function decorateArticle(article, fingerprint) {
  if (!article) {
    return null;
  }

  return {
    ...article,
    likes: Number(article.likes || 0),
    liked: hasLiked(article, fingerprint),
  };
}

function findArticleOrNull(data, slug) {
  const { articles } = getCollections(data);
  return createSlugMap(articles).get(slug) || null;
}

function findCommunityPostById(data, postId) {
  return ensureCommunityPosts(data).find((post) => post.id === postId) || null;
}

function getCommunityPostLikeCount(post) {
  const comments = Array.isArray(post && post.comments) ? post.comments : [];
  return (
    Number((post && post.likes) || 0) +
    comments.reduce(function (total, comment) {
      return total + Number((comment && comment.likes) || 0);
    }, 0)
  );
}

function getCommunityPostCommentCount(post) {
  return Array.isArray(post && post.comments) ? post.comments.length : 0;
}

function getCommentBranchLikeCount(comment) {
  const replies = Array.isArray(comment && comment.replies) ? comment.replies : [];
  return (
    Number((comment && comment.likes) || 0) +
    replies.reduce(function (total, reply) {
      return total + getCommentBranchLikeCount(reply);
    }, 0)
  );
}

function getCommentBranchCount(comment) {
  const replies = Array.isArray(comment && comment.replies) ? comment.replies : [];
  return 1 + replies.reduce(function (total, reply) { return total + getCommentBranchCount(reply); }, 0);
}

function getArticleCommentTotals(data, slug) {
  const articleComments = ensureArticleComments(data);
  const comments = Array.isArray(articleComments[slug]) ? articleComments[slug] : [];

  return comments.reduce(
    (total, comment) => ({
      likeCount: total.likeCount + getCommentBranchLikeCount(comment),
      commentCount: total.commentCount + getCommentBranchCount(comment),
    }),
    { likeCount: 0, commentCount: 0 }
  );
}

function findArticleCommentById(data, slug, commentId) {
  const articleComments = ensureArticleComments(data);
  const comments = Array.isArray(articleComments[slug]) ? articleComments[slug] : [];
  return comments.find((comment) => comment.id === commentId) || null;
}

function createSlugMap(items) {
  return new Map(items.map((item) => [item.slug, item]));
}

function formatDateParts(dateString) {
  const date = new Date(dateString);
  return {
    iso: dateString,
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    display: new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    }).format(date),
  };
}

function enrichArticle(article) {
  const safeArticle = {
    ...article,
    excerpt: String(article.excerpt || ""),
    content: String(article.content || ""),
    category: String(article.category || "未分类"),
    tags: Array.isArray(article.tags) ? article.tags : [],
    likes: Number(article.likes || 0),
  };
  const date = formatDateParts(safeArticle.date || new Date().toISOString().slice(0, 10));

  return {
    ...safeArticle,
    date,
  };
}

function uniqueValues(items) {
  return Array.from(new Set(items)).sort((a, b) => a.localeCompare(b));
}

function getCollections(data) {
  const articles = ensureArticles(data).map(enrichArticle).sort((a, b) => b.date.iso.localeCompare(a.date.iso));
  const categories = uniqueValues(articles.map((article) => article.category)).map((name) => ({
    name,
    count: articles.filter((article) => article.category === name).length,
  }));
  const tags = uniqueValues(articles.flatMap((article) => article.tags)).map((name) => ({
    name,
    count: articles.filter((article) => article.tags.includes(name)).length,
  }));

  return { articles, categories, tags };
}

function buildTimeline(articles) {
  const groups = new Map();

  articles.forEach((article) => {
    const key = `${article.date.year}-${String(article.date.month).padStart(2, "0")}`;
    const entry = groups.get(key) || {
      key,
      label: `${article.date.year}.${String(article.date.month).padStart(2, "0")}`,
      items: [],
    };

    entry.items.push({
      slug: article.slug,
      title: article.title,
      date: article.date.display,
      excerpt: article.excerpt,
      category: article.category,
    });

    groups.set(key, entry);
  });

  return Array.from(groups.values());
}

function normalizeIp(value) {
  return String(value || "")
    .trim()
    .replace(/^::ffff:/, "") || "unknown";
}

function getDayKey(date) {
  const target = date instanceof Date ? date : new Date(date);
  return (
    target.getFullYear() +
    "-" +
    String(target.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(target.getDate()).padStart(2, "0")
  );
}

function createVisitorFingerprint(req) {
  const ip = normalizeIp(req.ip);
  const userAgent = String(req.get("user-agent") || "").slice(0, 240);
  return crypto.createHash("sha1").update(`${ip}|${userAgent}`).digest("hex");
}

function getSourceLabel(req) {
  const referer = String(req.get("referer") || "").trim();
  if (!referer) {
    return "直接访问";
  }

  try {
    const refererUrl = new URL(referer);
    const host = String(req.get("host") || "").replace(/^www\./, "");
    const sourceHost = refererUrl.host.replace(/^www\./, "");
    if (sourceHost === host) {
      return "站内跳转";
    }

    return sourceHost;
  } catch (_error) {
    return "未知来源";
  }
}

function shouldTrackPageRequest(req) {
  if (req.method !== "GET") {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(pageMap, req.path)) {
    return true;
  }

  return req.path.startsWith("/articles/");
}

function recordPageVisit(req) {
  const data = readData();
  const analytics = ensureAnalytics(data);
  const fingerprint = createVisitorFingerprint(req);
  const now = new Date().toISOString();
  const dayKey = getDayKey(now);
  const sourceLabel = getSourceLabel(req);

  if (!analytics.daily[dayKey] || typeof analytics.daily[dayKey] !== "object") {
    analytics.daily[dayKey] = {
      pageViews: 0,
      uniqueVisitors: 0,
      uniqueVisitorFingerprints: {},
    };
  }

  analytics.pageViews += 1;
  analytics.lastVisitAt = now;
  analytics.sources[sourceLabel] = Math.max(0, Number(analytics.sources[sourceLabel] || 0)) + 1;
  analytics.daily[dayKey].pageViews += 1;

  if (!analytics.visitors[fingerprint]) {
    analytics.visitors[fingerprint] = {
      firstSeenAt: now,
      lastSeenAt: now,
    };
    analytics.uniqueVisitors += 1;
  } else {
    analytics.visitors[fingerprint].lastSeenAt = now;
  }

  if (!analytics.daily[dayKey].uniqueVisitorFingerprints[fingerprint]) {
    analytics.daily[dayKey].uniqueVisitorFingerprints[fingerprint] = true;
    analytics.daily[dayKey].uniqueVisitors += 1;
  }

  writeData(data);
}

function getSiteStats(data, articles) {
  const analytics = ensureAnalytics(data);
  const lastVisitAt = analytics.lastVisitAt || null;
  const todayKey = getDayKey(new Date());
  const todayStats = analytics.daily[todayKey] || { pageViews: 0, uniqueVisitors: 0 };

  return {
    articleCount: articles.length,
    categoryCount: uniqueValues(articles.map((article) => article.category)).length,
    tagCount: uniqueValues(articles.flatMap((article) => article.tags)).length,
    visitorCount: analytics.uniqueVisitors,
    viewCount: analytics.pageViews,
    likeCount: analytics.likeCount,
    commentCount: analytics.commentCount,
    todayViewCount: Number(todayStats.pageViews || 0),
    todayVisitorCount: Number(todayStats.uniqueVisitors || 0),
    lastVisitLabel: lastVisitAt
      ? new Intl.DateTimeFormat("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(lastVisitAt))
      : "尚无记录",
  };
}

function getAdminStats(data, articles) {
  const analytics = ensureAnalytics(data);
  const siteStats = getSiteStats(data, articles);
  const sourceItems = Object.keys(analytics.sources)
    .map((name) => ({
      name,
      count: Number(analytics.sources[name] || 0),
    }))
    .sort((a, b) => b.count - a.count);
  const dailyItems = Object.keys(analytics.daily)
    .sort()
    .slice(-7)
    .map((date) => ({
      date,
      pageViews: Number(analytics.daily[date].pageViews || 0),
      uniqueVisitors: Number(analytics.daily[date].uniqueVisitors || 0),
    }));
  const thirdParty = analytics.thirdParty;

  return {
    overview: {
      totalViews: siteStats.viewCount,
      totalVisitors: siteStats.visitorCount,
      totalLikes: siteStats.likeCount,
      totalComments: siteStats.commentCount,
      todayViews: siteStats.todayViewCount,
      todayVisitors: siteStats.todayVisitorCount,
      lastVisitLabel: siteStats.lastVisitLabel,
    },
    sources: sourceItems,
    daily: dailyItems,
    thirdParty: {
      provider: thirdParty.provider,
      enabled: thirdParty.enabled,
      configured:
        (thirdParty.provider === "plausible" && Boolean(thirdParty.domain && thirdParty.scriptUrl)) ||
        (thirdParty.provider === "google-analytics" && Boolean(thirdParty.measurementId)) ||
        (thirdParty.provider === "umami" && Boolean(thirdParty.websiteId && thirdParty.scriptUrl)) ||
        (thirdParty.provider === "clarity" && Boolean(thirdParty.clarityId)),
    },
  };
}

function pageTitle(pageType, detailTitle) {
  if (pageType === "article" && detailTitle) {
    return `${detailTitle} | 朝花夕拾`;
  }

  const labels = {
    home: "首页",
    archive: "归档",
    categories: "分类",
    tags: "标签",
    timeline: "时光机",
    about: "关于我",
    community: "社区",
    admin: "后台统计",
  };

  return `${labels[pageType] || "Blog"} | 朝花夕拾`;
}

function renderThirdPartyAnalyticsScript(config) {
  if (!config || !config.enabled) {
    return "";
  }

  if (config.provider === "plausible" && config.domain && config.scriptUrl) {
    return `<script defer data-domain="${config.domain}" src="${config.scriptUrl}"></script>`;
  }

  if (config.provider === "google-analytics" && config.measurementId) {
    return `<script async src="https://www.googletagmanager.com/gtag/js?id=${config.measurementId}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag("js", new Date());
      gtag("config", "${config.measurementId}");
    </script>`;
  }

  if (config.provider === "umami" && config.websiteId && config.scriptUrl) {
    return `<script defer src="${config.scriptUrl}" data-website-id="${config.websiteId}"></script>`;
  }

  if (config.provider === "clarity" && config.clarityId) {
    return `<script>
      (function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window, document, "clarity", "script", "${config.clarityId}");
    </script>`;
  }

  return "";
}

function renderShell({ pageType, articleSlug = null, detailTitle = null }) {
  const data = readData();
  const analytics = ensureAnalytics(data);
  const thirdPartyScript = renderThirdPartyAnalyticsScript(analytics.thirdParty);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${pageTitle(pageType, detailTitle)}</title>
    <link rel="preconnect" href="https://cdnjs.cloudflare.com" />
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" />
    <link rel="stylesheet" href="/app.css" />
    ${thirdPartyScript}
  </head>
  <body>
    <div class="video-background" aria-hidden="true">
      <video autoplay muted loop playsinline>
        <source src="/videos/wallpaper.mp4" type="video/mp4" />
      </video>
      <div class="video-background__overlay"></div>
    </div>
    <div id="app"></div>
    <script>
      window.__BLOG_STATE__ = ${JSON.stringify({ pageType, articleSlug })};
    </script>
    <script src="/app.js"></script>
  </body>
</html>`;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(assetRoots.images));
app.use("/videos", express.static(assetRoots.videos));

app.use((req, _res, next) => {
  if (shouldTrackPageRequest(req)) {
    recordPageVisit(req);
  }
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/site", (req, res) => {
  const data = readData();
  const { articles, categories, tags } = getCollections(data);

  res.json({
    site: data.site,
    profile: data.profile,
    navigation: data.navigation,
    stats: getSiteStats(data, articles),
    categories,
    tags,
    announcement: data.site.announcement,
  });
});

app.get("/api/admin/stats", (req, res) => {
  const data = readData();
  const { articles } = getCollections(data);
  res.json(getAdminStats(data, articles));
});

app.get("/api/articles", (req, res) => {
  const data = readData();
  const { articles } = getCollections(data);
  const selectedDate = req.query.date;
  const selectedCategory = req.query.category;
  const selectedTag = req.query.tag;
  const search = String(req.query.search || "").trim().toLowerCase();

  const filtered = articles.filter((article) => {
    if (selectedDate && article.date.iso !== selectedDate) return false;
    if (selectedCategory && article.category !== selectedCategory) return false;
    if (selectedTag && !article.tags.includes(selectedTag)) return false;
    if (!search) return true;

    return (
      article.title.toLowerCase().includes(search) ||
      article.excerpt.toLowerCase().includes(search) ||
      article.tags.join(" ").toLowerCase().includes(search)
    );
  });

  res.json({
    items: filtered,
    total: filtered.length,
  });
});

app.post("/api/articles", (req, res) => {
  const data = readData();
  const articles = ensureArticles(data);
  const normalized = normalizeArticlePayload(req.body, createId("article"));

  if (normalized.error) {
    res.status(400).json({ message: normalized.error });
    return;
  }

  if (articles.some((item) => item.slug === normalized.value.slug)) {
    res.status(409).json({ message: "文章链接标识已存在，请更换 slug。" });
    return;
  }

  const article = {
    ...normalized.value,
    likes: 0,
    likedBy: [],
  };

  articles.unshift(article);
  writeData(data);
  res.status(201).json({ item: enrichArticle(article) });
});

app.get("/api/articles/:slug", (req, res) => {
  const data = readData();
  const article = findArticleOrNull(data, req.params.slug);

  if (!article) {
    res.status(404).json({ message: "Article not found" });
    return;
  }

  res.json(decorateArticle(article, createVisitorFingerprint(req)));
});

app.put("/api/articles/:slug", (req, res) => {
  const data = readData();
  const articles = ensureArticles(data);
  const articleComments = ensureArticleComments(data);
  const article = articles.find((item) => item.slug === req.params.slug);
  const normalized = normalizeArticlePayload(req.body, req.params.slug);

  if (!article) {
    res.status(404).json({ message: "Article not found." });
    return;
  }

  if (normalized.error) {
    res.status(400).json({ message: normalized.error });
    return;
  }

  if (normalized.value.slug !== req.params.slug && articles.some((item) => item.slug === normalized.value.slug)) {
    res.status(409).json({ message: "文章链接标识已存在，请更换 slug。" });
    return;
  }

  const preservedLikes = Number(article.likes || 0);
  const preservedLikedBy = Array.isArray(article.likedBy) ? article.likedBy.slice() : [];
  const previousSlug = article.slug;

  Object.assign(article, normalized.value, {
    likes: preservedLikes,
    likedBy: preservedLikedBy,
  });

  if (previousSlug !== article.slug && Array.isArray(articleComments[previousSlug])) {
    articleComments[article.slug] = articleComments[previousSlug];
    delete articleComments[previousSlug];
  }

  writeData(data);
  res.json({ item: enrichArticle(article) });
});

app.delete("/api/articles/:slug", (req, res) => {
  const data = readData();
  const analytics = ensureAnalytics(data);
  const articles = ensureArticles(data);
  const articleComments = ensureArticleComments(data);
  const articleIndex = articles.findIndex((item) => item.slug === req.params.slug);

  if (articleIndex < 0) {
    res.status(404).json({ message: "Article not found." });
    return;
  }

  const article = articles[articleIndex];
  const commentTotals = getArticleCommentTotals(data, req.params.slug);

  analytics.likeCount = Math.max(0, analytics.likeCount - Number(article.likes || 0) - commentTotals.likeCount);
  analytics.commentCount = Math.max(0, analytics.commentCount - commentTotals.commentCount);

  delete articleComments[req.params.slug];
  articles.splice(articleIndex, 1);
  writeData(data);
  res.json({ ok: true });
});

app.post("/api/articles/:slug/like", (req, res) => {
  const data = readData();
  const article = findArticleOrNull(data, req.params.slug);
  const analytics = ensureAnalytics(data);
  const fingerprint = createVisitorFingerprint(req);

  if (!article) {
    res.status(404).json({ message: "Article not found." });
    return;
  }

  const result = toggleLike(article, fingerprint);
  analytics.likeCount = Math.max(0, analytics.likeCount + result.delta);
  writeData(data);
  res.json({ likes: result.likes, liked: result.liked });
});

app.get("/api/categories", (req, res) => {
  const data = readData();
  const { categories } = getCollections(data);
  res.json({ items: categories });
});

app.get("/api/tags", (req, res) => {
  const data = readData();
  const { tags } = getCollections(data);
  res.json({ items: tags });
});

app.get("/api/timeline", (req, res) => {
  const data = readData();
  const { articles } = getCollections(data);
  res.json({ items: buildTimeline(articles) });
});

app.get("/api/playlist", (req, res) => {
  const data = readData();
  res.json({ items: ensurePlaylist(data) });
});

app.post("/api/playlist", (req, res) => {
  const data = readData();
  const playlist = ensurePlaylist(data);
  const normalized = normalizeTrackPayload(req.body);

  if (normalized.error) {
    res.status(400).json({ message: normalized.error });
    return;
  }

  if (playlist.some((item) => item.id === normalized.value.id)) {
    res.status(409).json({ message: "歌曲 ID 已存在，请更换后再试。" });
    return;
  }

  playlist.unshift(normalized.value);
  writeData(data);
  res.status(201).json({ item: normalized.value });
});

app.put("/api/playlist/:id", (req, res) => {
  const data = readData();
  const playlist = ensurePlaylist(data);
  const trackIndex = playlist.findIndex((item) => item.id === req.params.id);

  if (trackIndex < 0) {
    res.status(404).json({ message: "Track not found." });
    return;
  }

  const normalized = normalizeTrackPayload(req.body, req.params.id);

  if (normalized.error) {
    res.status(400).json({ message: normalized.error });
    return;
  }

  if (normalized.value.id !== req.params.id && playlist.some((item) => item.id === normalized.value.id)) {
    res.status(409).json({ message: "歌曲 ID 已存在，请更换后再试。" });
    return;
  }

  playlist[trackIndex] = normalized.value;
  writeData(data);
  res.json({ item: normalized.value });
});

app.delete("/api/playlist/:id", (req, res) => {
  const data = readData();
  const playlist = ensurePlaylist(data);
  const trackIndex = playlist.findIndex((item) => item.id === req.params.id);

  if (trackIndex < 0) {
    res.status(404).json({ message: "Track not found." });
    return;
  }

  playlist.splice(trackIndex, 1);
  writeData(data);
  res.json({ ok: true });
});

app.get("/api/player/state", (req, res) => {
  const data = readData();
  const playerStates = ensurePlayerStates(data);
  const fingerprint = createVisitorFingerprint(req);
  res.json({ item: playerStates[fingerprint] || null });
});

app.post("/api/player/state", (req, res) => {
  const data = readData();
  const playerStates = ensurePlayerStates(data);
  const fingerprint = createVisitorFingerprint(req);

  playerStates[fingerprint] = {
    trackIndex: Math.max(0, readNumber(req.body && req.body.trackIndex, 0)),
    currentTime: Math.max(0, readNumber(req.body && req.body.currentTime, 0)),
    playing: Boolean(req.body && req.body.playing),
    volume: Math.max(0, Math.min(1, readNumber(req.body && req.body.volume, 0.75))),
    playlistOpen: Boolean(req.body && req.body.playlistOpen),
    updatedAt: new Date().toISOString(),
  };

  writeData(data);
  res.json({ ok: true, item: playerStates[fingerprint] });
});

app.get("/api/community", (req, res) => {
  const data = readData();
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 4));
  const posts = getCommunityPosts(data, createVisitorFingerprint(req));
  const result = paginateItems(posts, page, limit);

  res.json(result);
});

app.post("/api/community/posts", (req, res) => {
  const data = readData();
  const content = sanitizeText(req.body && req.body.content, 1000);

  if (!content) {
    res.status(400).json({ message: "Content is required." });
    return;
  }

  const posts = ensureCommunityPosts(data);
  const post = {
    id: createId("community-post"),
    author: normalizeAuthor(req.body),
    content,
    createdAt: new Date().toISOString(),
    likes: 0,
    comments: [],
  };

  posts.unshift(post);
  writeData(data);
  res.status(201).json({ item: post });
});

app.delete("/api/community/posts/:postId", (req, res) => {
  const data = readData();
  const posts = ensureCommunityPosts(data);
  const analytics = ensureAnalytics(data);
  const postIndex = posts.findIndex((post) => post.id === req.params.postId);

  if (postIndex < 0) {
    res.status(404).json({ message: "Post not found." });
    return;
  }

  const post = posts[postIndex];
  analytics.likeCount = Math.max(0, analytics.likeCount - getCommunityPostLikeCount(post));
  analytics.commentCount = Math.max(0, analytics.commentCount - getCommunityPostCommentCount(post));
  posts.splice(postIndex, 1);
  writeData(data);
  res.json({ ok: true });
});

app.post("/api/community/posts/:postId/like", (req, res) => {
  const data = readData();
  const post = findCommunityPostById(data, req.params.postId);
  const analytics = ensureAnalytics(data);
  const fingerprint = createVisitorFingerprint(req);

  if (!post) {
    res.status(404).json({ message: "Post not found." });
    return;
  }

  const result = toggleLike(post, fingerprint);
  analytics.likeCount = Math.max(0, analytics.likeCount + result.delta);
  writeData(data);
  res.json({ likes: result.likes, liked: result.liked });
});

app.post("/api/community/posts/:postId/comments", (req, res) => {
  const data = readData();
  const post = findCommunityPostById(data, req.params.postId);
  const analytics = ensureAnalytics(data);

  if (!post) {
    res.status(404).json({ message: "Post not found." });
    return;
  }

  const content = sanitizeText(req.body && req.body.content, 600);

  if (!content) {
    res.status(400).json({ message: "Content is required." });
    return;
  }

  const comment = {
    id: createId("community-comment"),
    author: normalizeAuthor(req.body),
    content,
    createdAt: new Date().toISOString(),
    likes: 0,
  };

  if (!Array.isArray(post.comments)) {
    post.comments = [];
  }

  post.comments.unshift(comment);
  analytics.commentCount += 1;
  writeData(data);
  res.status(201).json({ item: comment });
});

app.delete("/api/community/posts/:postId/comments/:commentId", (req, res) => {
  const data = readData();
  const post = findCommunityPostById(data, req.params.postId);
  const analytics = ensureAnalytics(data);

  if (!post || !Array.isArray(post.comments)) {
    res.status(404).json({ message: "Comment not found." });
    return;
  }

  const commentIndex = post.comments.findIndex((item) => item.id === req.params.commentId);
  if (commentIndex < 0) {
    res.status(404).json({ message: "Comment not found." });
    return;
  }

  const comment = post.comments[commentIndex];
  analytics.likeCount = Math.max(0, analytics.likeCount - Number(comment.likes || 0));
  analytics.commentCount = Math.max(0, analytics.commentCount - 1);
  post.comments.splice(commentIndex, 1);
  writeData(data);
  res.json({ ok: true });
});

app.post("/api/community/posts/:postId/comments/:commentId/like", (req, res) => {
  const data = readData();
  const post = findCommunityPostById(data, req.params.postId);
  const analytics = ensureAnalytics(data);
  const fingerprint = createVisitorFingerprint(req);

  if (!post || !Array.isArray(post.comments)) {
    res.status(404).json({ message: "Comment not found." });
    return;
  }

  const comment = post.comments.find((item) => item.id === req.params.commentId);

  if (!comment) {
    res.status(404).json({ message: "Comment not found." });
    return;
  }

  const result = toggleLike(comment, fingerprint);
  analytics.likeCount = Math.max(0, analytics.likeCount + result.delta);
  writeData(data);
  res.json({ likes: result.likes, liked: result.liked });
});

app.get("/api/articles/:slug/comments", (req, res) => {
  const data = readData();
  const article = findArticleOrNull(data, req.params.slug);

  if (!article) {
    res.status(404).json({ message: "Article not found." });
    return;
  }

  res.json({ items: getArticleComments(data, req.params.slug, createVisitorFingerprint(req)) });
});

app.post("/api/articles/:slug/comments", (req, res) => {
  const data = readData();
  const article = findArticleOrNull(data, req.params.slug);
  const analytics = ensureAnalytics(data);

  if (!article) {
    res.status(404).json({ message: "Article not found." });
    return;
  }

  const content = sanitizeText(req.body && req.body.content, 600);

  if (!content) {
    res.status(400).json({ message: "Content is required." });
    return;
  }

  const articleComments = ensureArticleComments(data);
  const comments = Array.isArray(articleComments[req.params.slug]) ? articleComments[req.params.slug] : [];
  const parentId = sanitizeText(req.body && req.body.parentId, 80);

  if (!parentId) {
    const comment = {
      id: createId("article-comment"),
      author: normalizeAuthor(req.body),
      content,
      createdAt: new Date().toISOString(),
      likes: 0,
      replies: [],
    };

    comments.unshift(comment);
    articleComments[req.params.slug] = comments;
    analytics.commentCount += 1;
    writeData(data);
    res.status(201).json({ item: comment });
    return;
  }

  const parentComment = comments.find((comment) => comment.id === parentId);

  if (!parentComment) {
    res.status(404).json({ message: "Parent comment not found." });
    return;
  }

  if (!Array.isArray(parentComment.replies)) {
    parentComment.replies = [];
  }

  const reply = {
    id: createId("article-reply"),
    author: normalizeAuthor(req.body),
    content,
    createdAt: new Date().toISOString(),
    likes: 0,
  };

  parentComment.replies.unshift(reply);
  articleComments[req.params.slug] = comments;
  analytics.commentCount += 1;
  writeData(data);
  res.status(201).json({ item: reply });
});

app.delete("/api/articles/:slug/comments/:commentId", (req, res) => {
  const data = readData();
  const article = findArticleOrNull(data, req.params.slug);
  const analytics = ensureAnalytics(data);

  if (!article) {
    res.status(404).json({ message: "Article not found." });
    return;
  }

  const articleComments = ensureArticleComments(data);
  const comments = Array.isArray(articleComments[req.params.slug]) ? articleComments[req.params.slug] : [];
  const commentIndex = comments.findIndex((comment) => comment.id === req.params.commentId);

  if (commentIndex < 0) {
    res.status(404).json({ message: "Comment not found." });
    return;
  }

  const comment = comments[commentIndex];
  analytics.likeCount = Math.max(0, analytics.likeCount - getCommentBranchLikeCount(comment));
  analytics.commentCount = Math.max(0, analytics.commentCount - getCommentBranchCount(comment));
  comments.splice(commentIndex, 1);
  articleComments[req.params.slug] = comments;
  writeData(data);
  res.json({ ok: true });
});

app.delete("/api/articles/:slug/comments/:commentId/replies/:replyId", (req, res) => {
  const data = readData();
  const article = findArticleOrNull(data, req.params.slug);
  const analytics = ensureAnalytics(data);

  if (!article) {
    res.status(404).json({ message: "Article not found." });
    return;
  }

  const comment = findArticleCommentById(data, req.params.slug, req.params.commentId);
  const replies = comment && Array.isArray(comment.replies) ? comment.replies : [];
  const replyIndex = replies.findIndex((item) => item.id === req.params.replyId);

  if (replyIndex < 0) {
    res.status(404).json({ message: "Reply not found." });
    return;
  }

  const reply = replies[replyIndex];
  analytics.likeCount = Math.max(0, analytics.likeCount - getCommentBranchLikeCount(reply));
  analytics.commentCount = Math.max(0, analytics.commentCount - getCommentBranchCount(reply));
  replies.splice(replyIndex, 1);
  writeData(data);
  res.json({ ok: true });
});

app.post("/api/articles/:slug/comments/:commentId/like", (req, res) => {
  const data = readData();
  const article = findArticleOrNull(data, req.params.slug);
  const analytics = ensureAnalytics(data);
  const fingerprint = createVisitorFingerprint(req);

  if (!article) {
    res.status(404).json({ message: "Article not found." });
    return;
  }

  const comment = findArticleCommentById(data, req.params.slug, req.params.commentId);

  if (!comment) {
    res.status(404).json({ message: "Comment not found." });
    return;
  }

  const result = toggleLike(comment, fingerprint);
  analytics.likeCount = Math.max(0, analytics.likeCount + result.delta);
  writeData(data);
  res.json({ likes: result.likes, liked: result.liked });
});

app.post("/api/articles/:slug/comments/:commentId/replies/:replyId/like", (req, res) => {
  const data = readData();
  const article = findArticleOrNull(data, req.params.slug);
  const analytics = ensureAnalytics(data);
  const fingerprint = createVisitorFingerprint(req);

  if (!article) {
    res.status(404).json({ message: "Article not found." });
    return;
  }

  const comment = findArticleCommentById(data, req.params.slug, req.params.commentId);
  const replies = comment && Array.isArray(comment.replies) ? comment.replies : [];
  const reply = replies.find((item) => item.id === req.params.replyId);

  if (!reply) {
    res.status(404).json({ message: "Reply not found." });
    return;
  }

  const result = toggleLike(reply, fingerprint);
  analytics.likeCount = Math.max(0, analytics.likeCount + result.delta);
  writeData(data);
  res.json({ likes: result.likes, liked: result.liked });
});

app.get(Object.keys(pageMap), (req, res) => {
  res.send(renderShell({ pageType: pageMap[req.path] }));
});

app.get("/articles/:slug", (req, res) => {
  const data = readData();
  const article = findArticleOrNull(data, req.params.slug);

  if (!article) {
    res.status(404).send(renderShell({ pageType: "home" }));
    return;
  }

  res.send(renderShell({ pageType: "article", articleSlug: article.slug, detailTitle: article.title }));
});

app.listen(PORT, () => {
  console.log(`Full-stack blog is running on port ${PORT}`);
});
