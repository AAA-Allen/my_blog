const assert = require("assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "blog-security-smoke-"));
const tempDataPath = path.join(tempDirectory, "site-data.json");
const tempUploadPath = path.join(tempDirectory, "uploads");
const port = 45000 + Math.floor(Math.random() * 4000);
const baseUrl = `http://127.0.0.1:${port}`;
const adminPassword = "test-admin-password-2026";
const adminSessionSecret = "test-admin-session-secret-that-is-longer-than-thirty-two-characters";

fs.copyFileSync(path.join(root, "fullstack", "data", "site-data.json"), tempDataPath);

let output = "";
const server = spawn(process.execPath, [path.join(root, "fullstack", "server.js")], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    BLOG_DATA_PATH: tempDataPath,
    BLOG_UPLOAD_DIR: tempUploadPath,
    NODE_ENV: "test",
    ADMIN_PASSWORD: adminPassword,
    ADMIN_SESSION_SECRET: adminSessionSecret,
    PUBLIC_SITE_URL: baseUrl,
    TRUST_PROXY_HOPS: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

function request(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (options.body !== undefined && !isFormData && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  return fetch(baseUrl + pathname, {
    ...options,
    headers,
    body:
      options.body === undefined || typeof options.body === "string" || isFormData
        ? options.body
        : JSON.stringify(options.body),
  });
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Test server exited early.\n${output}`);
    try {
      const response = await request("/healthz");
      if (response.ok) return;
    } catch (_error) {
      // The child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for test server.\n${output}`);
}

async function run() {
  await waitForServer();

  let response = await request("/rss.xml");
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type")), /application\/rss\+xml/);
  assert.match(await response.text(), /<rss version="2\.0">/);

  response = await request("/sitemap.xml");
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type")), /application\/xml/);
  const sitemap = await response.text();
  assert.ok(sitemap.includes(`<loc>${baseUrl}/</loc>`));
  assert.ok(sitemap.includes(`<loc>${baseUrl}/photos</loc>`));

  response = await request("/robots.txt");
  assert.equal(response.status, 200);
  assert.match(await response.text(), new RegExp(`Sitemap: ${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/sitemap\\.xml`));

  response = await request("/missing-page-for-smoke-test");
  assert.equal(response.status, 404);
  let html = await response.text();
  assert.match(html, /<meta name="robots" content="noindex, follow" \/>/);
  assert.match(html, /"pageType":"notFound"/);

  response = await request("/photos");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"pageType":"photos"/);

  response = await request("/api/timeline");
  assert.equal(response.status, 200);
  const timeline = await readJson(response);
  assert.ok(Array.isArray(timeline.items));
  assert.ok(timeline.items.length > 0);
  assert.match(String(timeline.items[0].label || ""), /^\d{4}$/);
  assert.ok(Array.isArray(timeline.items[0].items));
  assert.ok(timeline.items[0].items[0].dateLabel);
  assert.ok(timeline.items[0].items[0].weekday);

  response = await request("/api/player/state", {
    method: "POST",
    body: {
      trackIndex: 1,
      trackId: "player-state-smoke",
      currentTime: 12,
      playing: false,
      volume: 0,
      playlistOpen: true,
    },
  });
  assert.equal(response.status, 200);
  let playerState = (await readJson(response)).item;
  assert.equal(playerState.volume, 0);
  assert.equal(playerState.trackId, "player-state-smoke");
  assert.ok(playerState.updatedAt);

  response = await request("/api/player/state");
  assert.equal(response.status, 200);
  playerState = (await readJson(response)).item;
  assert.equal(playerState.volume, 0);
  assert.equal(playerState.trackId, "player-state-smoke");

  response = await request("/api/admin/session");
  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).authenticated, false);

  response = await request("/api/admin/stats");
  assert.equal(response.status, 401);

  response = await request("/api/admin/articles");
  assert.equal(response.status, 401);

  response = await request("/api/admin/media");
  assert.equal(response.status, 401);

  response = await request("/api/admin/settings", { method: "PUT", body: { title: "blocked" } });
  assert.equal(response.status, 401);

  response = await request("/api/admin/articles/preview", {
    method: "POST",
    body: { format: "markdown", content: "## blocked" },
  });
  assert.equal(response.status, 401);

  response = await request("/api/articles", {
    method: "POST",
    body: { title: "unauthorized", content: "blocked" },
  });
  assert.equal(response.status, 401);

  const communityPostIds = [];
  for (let index = 0; index < 3; index += 1) {
    response = await request("/api/community/posts", {
      method: "POST",
      body: { name: "测试访客", content: `临时社区留言 ${index + 1}` },
    });
    assert.equal(response.status, 201);
    communityPostIds.push((await readJson(response)).item.id);
  }

  response = await request("/api/community/posts", {
    method: "POST",
    body: { name: "测试访客", content: "这条应被限流" },
  });
  assert.equal(response.status, 429);

  response = await request(`/api/community/posts/${encodeURIComponent(communityPostIds[0])}/comments`, {
    method: "POST",
    body: { name: "测试访客", content: "公开社区评论" },
  });
  assert.equal(response.status, 201);

  response = await request(`/api/community/posts/${encodeURIComponent(communityPostIds[0])}`, { method: "DELETE" });
  assert.equal(response.status, 401);

  response = await request("/api/articles/hello-world/comments", {
    method: "POST",
    body: { name: "测试访客", content: "文章评论应关闭" },
  });
  assert.equal(response.status, 403);

  response = await request("/api/netease/cover?url=http%3A%2F%2F127.0.0.1%3A" + port + "%2Fhealthz");
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type")), /^image\//);
  assert.doesNotMatch(await response.text(), /"ok"\s*:\s*true/);

  response = await request("/api/admin/session", {
    method: "POST",
    body: { password: "wrong-password" },
  });
  assert.equal(response.status, 401);

  response = await request("/api/admin/session", {
    method: "POST",
    body: { password: adminPassword },
  });
  assert.equal(response.status, 200);
  const cookie = String(response.headers.get("set-cookie") || "").split(";", 1)[0];
  assert.match(cookie, /^blog_admin_session=/);

  const adminHeaders = { Cookie: cookie };
  response = await request("/api/admin/stats", { headers: adminHeaders });
  assert.equal(response.status, 200);

  response = await request("/api/admin/settings", {
    method: "PUT",
    headers: adminHeaders,
    body: {
      title: "朝花夕拾",
      name: "Allen",
      tagline: "测试站点资料",
      announcement: "测试公告",
      bio: "测试简介",
      about: "测试关于页",
      avatar: "/images/avatar.jpg",
      copyright: "© 2026 朝花夕拾",
      github: "https://github.com/example",
      weibo: "javascript:alert(1)",
      douyin: "",
    },
  });
  assert.equal(response.status, 200);
  response = await request("/api/site");
  const updatedSite = await readJson(response);
  assert.equal(updatedSite.site.tagline, "测试站点资料");
  assert.equal(updatedSite.profile.socials.length, 1);
  assert.equal(updatedSite.profile.socials[0].url, "https://github.com/example");

  response = await request("/api/admin/articles/preview", {
    method: "POST",
    headers: adminHeaders,
    body: { format: "markdown", content: "## 安全预览\n<script>alert(1)</script>\n**正文**" },
  });
  assert.equal(response.status, 200);
  const preview = await readJson(response);
  assert.match(preview.html, /<h2>安全预览<\/h2>/);
  assert.match(preview.html, /<strong>正文<\/strong>/);
  assert.doesNotMatch(preview.html, /<script/i);

  const upload = new FormData();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  upload.append("image", new Blob([png], { type: "image/png" }), "smoke.png");
  upload.append("isPhoto", "true");
  response = await request("/api/admin/uploads", {
    method: "POST",
    headers: adminHeaders,
    body: upload,
  });
  assert.equal(response.status, 201);
  const uploadedImage = await readJson(response);
  assert.match(uploadedImage.url, /^\/uploads\/media-[a-z0-9-]+-original\.webp$/);
  assert.ok(uploadedImage.item && uploadedImage.item.id);
  const mediaId = uploadedImage.item.id;
  assert.equal(fs.existsSync(path.join(tempUploadPath, path.basename(uploadedImage.url))), true);

  response = await request("/api/photos");
  assert.equal(response.status, 200);
  assert.ok((await readJson(response)).items.some((item) => item.id === mediaId));

  response = await request("/api/admin/media", { headers: adminHeaders });
  assert.equal(response.status, 200);
  assert.ok((await readJson(response)).items.some((item) => item.id === mediaId && item.isPhoto));

  const rejectedUpload = new FormData();
  rejectedUpload.append("image", new Blob(["<svg></svg>"], { type: "image/svg+xml" }), "blocked.svg");
  response = await request("/api/admin/uploads", {
    method: "POST",
    headers: adminHeaders,
    body: rejectedUpload,
  });
  assert.equal(response.status, 400);

  const workflowSlug = `workflow-smoke-${Date.now()}`;
  response = await request("/api/articles", {
    method: "POST",
    headers: adminHeaders,
    body: {
      slug: workflowSlug,
      title: "后台工作流草稿",
      excerpt: "draft should stay private",
      content: "## 草稿标题\n\n正文 **Markdown**",
      format: "markdown",
      status: "draft",
      coverMediaId: mediaId,
      category: "测试",
      tags: ["工作流"],
      date: "2026-07-14",
    },
  });
  assert.equal(response.status, 201);
  let workflowArticle = (await readJson(response)).item;
  assert.equal(workflowArticle.status, "draft");
  assert.equal(workflowArticle.format, "markdown");
  assert.match(workflowArticle.content, /<h2>草稿标题<\/h2>/);

  response = await request(`/api/articles/${encodeURIComponent(workflowSlug)}`);
  assert.equal(response.status, 404);

  response = await request("/api/admin/articles", { headers: adminHeaders });
  assert.equal(response.status, 200);
  assert.ok((await readJson(response)).items.some((item) => item.slug === workflowSlug && item.status === "draft"));

  response = await request(`/api/articles/${encodeURIComponent(workflowSlug)}`, {
    method: "PUT",
    headers: adminHeaders,
    body: {
      slug: workflowSlug,
      title: "后台工作流已发布",
      excerpt: "published workflow",
      content: "## 发布版本\n\n公开正文",
      format: "markdown",
      status: "published",
      coverMediaId: mediaId,
      category: "测试",
      tags: ["工作流"],
      date: "2026-07-14",
    },
  });
  assert.equal(response.status, 200);

  response = await request(`/api/articles/${encodeURIComponent(workflowSlug)}`);
  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).cover.id, mediaId);

  response = await request("/api/articles?search=" + encodeURIComponent("公开正文"));
  assert.equal(response.status, 200);
  const searchResult = await readJson(response);
  assert.ok(searchResult.items.some((item) => item.slug === workflowSlug && item.searchSnippet.includes("公开正文")));

  response = await request(`/api/admin/media/${encodeURIComponent(mediaId)}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  assert.equal(response.status, 409);

  response = await request(`/api/admin/articles/${encodeURIComponent(workflowSlug)}/versions`, {
    headers: adminHeaders,
  });
  assert.equal(response.status, 200);
  const versions = (await readJson(response)).items;
  assert.ok(versions.length >= 2);

  response = await request(
    `/api/admin/articles/${encodeURIComponent(workflowSlug)}/versions/${encodeURIComponent(versions[0].id)}/restore`,
    { method: "POST", headers: adminHeaders }
  );
  assert.equal(response.status, 200);
  workflowArticle = (await readJson(response)).item;
  assert.equal(workflowArticle.status, "draft");

  response = await request(`/api/articles/${encodeURIComponent(workflowSlug)}`);
  assert.equal(response.status, 404);

  const futureSlug = `scheduled-future-${Date.now()}`;
  response = await request("/api/articles", {
    method: "POST",
    headers: adminHeaders,
    body: {
      slug: futureSlug,
      title: "未来定时文章",
      content: "未来才公开",
      format: "markdown",
      status: "scheduled",
      publishAt: "2099-01-01T00:00:00.000Z",
      date: "2026-07-14",
    },
  });
  assert.equal(response.status, 201);
  response = await request(`/api/articles/${encodeURIComponent(futureSlug)}`);
  assert.equal(response.status, 404);

  const pastSlug = `scheduled-past-${Date.now()}`;
  response = await request("/api/articles", {
    method: "POST",
    headers: adminHeaders,
    body: {
      slug: pastSlug,
      title: "到点定时文章",
      content: "已经自动公开",
      format: "markdown",
      status: "scheduled",
      publishAt: "2020-01-01T00:00:00.000Z",
      date: "2026-07-14",
    },
  });
  assert.equal(response.status, 201);
  response = await request(`/api/articles/${encodeURIComponent(pastSlug)}`);
  assert.equal(response.status, 200);

  const slug = `security-smoke-${Date.now()}`;
  response = await request("/api/articles", {
    method: "POST",
    headers: adminHeaders,
    body: {
      slug,
      title: "</title><script>window.__titleXss = true</script>",
      excerpt: "security smoke test",
      content: '<p>安全正文</p><img src="x" onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">链接</a>',
      category: "测试",
      tags: ["安全"],
      date: "2026-07-14",
    },
  });
  assert.equal(response.status, 201);
  let article = (await readJson(response)).item;
  assert.doesNotMatch(article.content, /onerror|<script|javascript:/i);

  response = await request(`/articles/${encodeURIComponent(slug)}`);
  assert.equal(response.status, 200);
  html = await response.text();
  assert.doesNotMatch(html, /<title><\/title><script>/i);
  assert.match(html, /<script type="application\/ld\+json">/);
  assert.match(html, /<meta property="og:type" content="article" \/>/);
  assert.match(html, new RegExp(`<link rel="canonical" href="${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/articles\/`));
  assert.match(html, /<main class="ssr-article" data-ssr="article">/);
  assert.match(html, /<p>安全正文<\/p>/);

  response = await request("/api/articles?page=1&limit=1");
  assert.equal(response.status, 200);
  const paginatedArticles = await readJson(response);
  assert.equal(paginatedArticles.items.length, 1);
  assert.equal(paginatedArticles.pagination.limit, 1);
  assert.equal(paginatedArticles.pagination.page, 1);

  response = await request(`/api/articles/${encodeURIComponent(slug)}/like`, {
    method: "POST",
    headers: { "User-Agent": "security-smoke-like-client" },
  });
  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).likes, 1);

  response = await request(`/api/articles/${encodeURIComponent(slug)}`, {
    headers: { "User-Agent": "security-smoke-like-client" },
  });
  article = await readJson(response);
  assert.equal(article.likes, 1);
  assert.equal(article.liked, true);

  response = await request("/api/playlist", {
    method: "POST",
    headers: adminHeaders,
    body: {
      title: "oversized melody",
      artist: "test",
      bpm: 40,
      notes: [{ frequency: 440, beats: 1000000 }],
    },
  });
  assert.equal(response.status, 400);

  for (const postId of communityPostIds) {
    response = await request(`/api/community/posts/${encodeURIComponent(postId)}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    assert.equal(response.status, 200);
  }

  for (const articleSlug of [workflowSlug, futureSlug, pastSlug]) {
    response = await request(`/api/articles/${encodeURIComponent(articleSlug)}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    assert.equal(response.status, 200);
  }

  response = await request(`/api/articles/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  assert.equal(response.status, 200);

  response = await request(`/api/admin/media/${encodeURIComponent(mediaId)}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  assert.equal(response.status, 200);
  assert.equal(fs.existsSync(path.join(tempUploadPath, path.basename(uploadedImage.url))), false);

  console.log("Security smoke test passed.");
}

run()
  .catch((error) => {
    console.error(error.stack || error.message);
    if (output) console.error(`\nTest server output:\n${output}`);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });
