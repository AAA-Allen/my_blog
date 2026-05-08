const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
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
};

let visitorCount = 0;

function readData() {
  const raw = fs.readFileSync(dataPath, "utf8");
  return JSON.parse(raw);
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
  const date = formatDateParts(article.date);

  return {
    ...article,
    date,
  };
}

function uniqueValues(items) {
  return Array.from(new Set(items)).sort((a, b) => a.localeCompare(b));
}

function getCollections(data) {
  const articles = data.articles.map(enrichArticle).sort((a, b) => b.date.iso.localeCompare(a.date.iso));
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

function getSiteStats(data, articles) {
  return {
    articleCount: articles.length,
    categoryCount: uniqueValues(articles.map((article) => article.category)).length,
    tagCount: uniqueValues(articles.flatMap((article) => article.tags)).length,
    visitorCount: data.site.visitorBase + visitorCount,
    viewCount: data.site.viewBase + visitorCount * 3,
    updatedLabel: new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(data.site.updatedAt)),
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
  };

  return `${labels[pageType] || "Blog"} | 朝花夕拾`;
}

function renderShell({ pageType, articleSlug = null, detailTitle = null }) {
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
  if (!req.path.startsWith("/api")) {
    visitorCount += 1;
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

app.get("/api/articles/:slug", (req, res) => {
  const data = readData();
  const { articles } = getCollections(data);
  const article = createSlugMap(articles).get(req.params.slug);

  if (!article) {
    res.status(404).json({ message: "Article not found" });
    return;
  }

  res.json(article);
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
  res.json({ items: data.playlist });
});

app.get(Object.keys(pageMap), (req, res) => {
  res.send(renderShell({ pageType: pageMap[req.path] }));
});

app.get("/articles/:slug", (req, res) => {
  const data = readData();
  const { articles } = getCollections(data);
  const article = createSlugMap(articles).get(req.params.slug);

  if (!article) {
    res.status(404).send(renderShell({ pageType: "home" }));
    return;
  }

  res.send(renderShell({ pageType: "article", articleSlug: article.slug, detailTitle: article.title }));
});

app.listen(PORT, () => {
  console.log(`Full-stack blog is running on port ${PORT}`);
});
