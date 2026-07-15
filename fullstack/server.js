require("dotenv").config({ quiet: true });

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sanitizeHtml = require("sanitize-html");
const multer = require("multer");
const { marked } = require("marked");
const sharp = require("sharp");
const exifReader = require("exif-reader");

const app = express();
app.disable("x-powered-by");
const parsedTrustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
const trustProxyHops =
  process.env.TRUST_PROXY_HOPS === undefined || process.env.TRUST_PROXY_HOPS === ""
    ? 1
    : Number.isInteger(parsedTrustProxyHops) && parsedTrustProxyHops >= 0 && parsedTrustProxyHops <= 10
      ? parsedTrustProxyHops
      : 1;

if (
  process.env.TRUST_PROXY_HOPS !== undefined &&
  process.env.TRUST_PROXY_HOPS !== "" &&
  trustProxyHops !== parsedTrustProxyHops
) {
  console.warn("[Proxy] TRUST_PROXY_HOPS must be an integer between 0 and 10; using 1.");
}

app.set("trust proxy", trustProxyHops);
const PORT = Number(process.env.PORT || 4321);
const dataPath = path.resolve(process.env.BLOG_DATA_PATH || path.join(__dirname, "data", "site-data.json"));
const uploadRoot = path.resolve(process.env.BLOG_UPLOAD_DIR || path.join(__dirname, "uploads"));
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
  "/photos": "photos",
  "/community": "community",
  "/admin": "admin",
};

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ADMIN_COOKIE_NAME = "blog_admin_session";
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const ADMIN_LOGIN_LOCK_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_FAILURES = 5;
const COMMUNITY_RATE_WINDOW_MS = 10 * 60 * 1000;
const COMMUNITY_POST_RATE_LIMIT = 3;
const COMMUNITY_COMMENT_RATE_LIMIT = 10;
const MAX_RATE_BUCKETS = 10000;
const MAX_TRACK_NOTE_BEATS = 8;
const MAX_TRACK_TOTAL_BEATS = 64;
const MAX_TRACK_DURATION_SECONDS = 90;
const MAX_TRACK_FREQUENCY = 10000;
const DEFAULT_ARTICLE_PAGE_SIZE = 8;
const MAX_ARTICLE_PAGE_SIZE = 30;
const MAX_ARTICLE_SOURCE_LENGTH = 200000;
const MAX_ARTICLE_VERSIONS = 30;
const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40 * 1000 * 1000;

const allowedImageTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES, files: 1 },
  fileFilter(_req, file, callback) {
    if (!allowedImageTypes.has(file.mimetype)) {
      callback(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "image"));
      return;
    }
    callback(null, true);
  },
});

function acceptImageUpload(req, res, next) {
  imageUpload.single("image")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ message: "图片不能超过 5 MB。" });
      return;
    }

    res.status(400).json({ message: "只支持 JPG、PNG、WebP 或 GIF 图片。" });
  });
}

function normalizeExifDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const text = String(value).trim();
  const normalized = text.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readSafeExif(exifBuffer) {
  if (!exifBuffer) return {};

  try {
    const parsed = exifReader(exifBuffer);
    const image = parsed.Image || {};
    const photo = parsed.Photo || {};
    const make = sanitizeText(image.Make, 80);
    const model = sanitizeText(image.Model, 80);
    return {
      takenAt: normalizeExifDate(photo.DateTimeOriginal || image.DateTime),
      camera: sanitizeText([make, model].filter(Boolean).join(" "), 120),
      lens: sanitizeText(photo.LensModel, 120),
      aperture: sanitizeText(photo.FNumber, 30),
      shutter: sanitizeText(photo.ExposureTime, 30),
      iso: sanitizeText(photo.ISOSpeedRatings || photo.PhotographicSensitivity, 30),
      focalLength: sanitizeText(photo.FocalLength, 30),
    };
  } catch (_error) {
    return {};
  }
}

async function processUploadedImage(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) {
    throw new Error("图片内容为空。");
  }

  const source = sharp(file.buffer, {
    failOn: "error",
    limitInputPixels: MAX_IMAGE_PIXELS,
    animated: false,
  });
  const metadata = await source.metadata();
  if (!allowedImageTypes.has(`image/${metadata.format === "jpg" ? "jpeg" : metadata.format}`)) {
    throw new Error("图片真实格式不受支持。");
  }

  const id = createId("media");
  const fileNames = {
    original: `${id}-original.webp`,
    large: `${id}-1600.webp`,
    medium: `${id}-960.webp`,
    thumbnail: `${id}-480.webp`,
  };
  fs.mkdirSync(uploadRoot, { recursive: true });

  const rotated = source.rotate();
  const outputs = await Promise.all([
    rotated.clone().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toFile(path.join(uploadRoot, fileNames.original)),
    rotated.clone().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toFile(path.join(uploadRoot, fileNames.large)),
    rotated.clone().resize({ width: 960, height: 960, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(uploadRoot, fileNames.medium)),
    rotated.clone().resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toFile(path.join(uploadRoot, fileNames.thumbnail)),
  ]);
  const originalName = path.basename(file.originalname || "image").replace(/\.[^.]+$/, "");
  const exif = readSafeExif(metadata.exif);
  const createdAt = new Date().toISOString();

  return {
    id,
    provider: "local",
    title: sanitizeText(originalName, 120) || "未命名图片",
    alt: sanitizeText(originalName, 160) || "博客图片",
    caption: "",
    url: `/uploads/${fileNames.original}`,
    largeUrl: `/uploads/${fileNames.large}`,
    mediumUrl: `/uploads/${fileNames.medium}`,
    thumbnailUrl: `/uploads/${fileNames.thumbnail}`,
    width: Number(outputs[0].width || metadata.width || 0),
    height: Number(outputs[0].height || metadata.height || 0),
    format: "webp",
    bytes: Number(outputs[0].size || 0),
    originalFormat: String(metadata.format || ""),
    takenAt: exif.takenAt || createdAt,
    exif: {
      camera: exif.camera || "",
      lens: exif.lens || "",
      aperture: exif.aperture || "",
      shutter: exif.shutter || "",
      iso: exif.iso || "",
      focalLength: exif.focalLength || "",
    },
    isPhoto: false,
    status: "published",
    createdAt,
    updatedAt: createdAt,
  };
}

const adminLoginAttempts = new Map();
const communityRateBuckets = new Map();

let adminPassword = String(process.env.ADMIN_PASSWORD || "");
let adminSessionSecret = String(process.env.ADMIN_SESSION_SECRET || "");
let generatedDevelopmentPassword = false;

if (!IS_PRODUCTION) {
  if (!adminPassword) {
    adminPassword = crypto.randomBytes(15).toString("base64url");
    generatedDevelopmentPassword = true;
  }

  if (Buffer.byteLength(adminSessionSecret, "utf8") < 32) {
    adminSessionSecret = crypto.randomBytes(48).toString("base64url");
  }
}

const adminAuthReady =
  Buffer.byteLength(adminPassword, "utf8") >= 8 && Buffer.byteLength(adminSessionSecret, "utf8") >= 32;

if (!adminAuthReady) {
  console.error(
    "[Admin auth] Disabled: ADMIN_PASSWORD must be at least 8 bytes and ADMIN_SESSION_SECRET at least 32 bytes."
  );
} else if (generatedDevelopmentPassword) {
  console.warn(`[Admin auth] Temporary development password: ${adminPassword}`);
  console.warn("[Admin auth] It changes on restart. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET to keep sessions stable.");
} else if (!IS_PRODUCTION && !process.env.ADMIN_SESSION_SECRET) {
  console.warn("[Admin auth] Using a temporary development session secret; sessions will reset on restart.");
}

function readData() {
  const raw = fs.readFileSync(dataPath, "utf8");
  return JSON.parse(raw);
}

function writeData(data) {
  const directory = path.dirname(dataPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(dataPath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  let fileDescriptor = null;

  fs.mkdirSync(directory, { recursive: true });

  try {
    fileDescriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(fileDescriptor, serialized, "utf8");
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;
    fs.renameSync(temporaryPath, dataPath);
  } catch (error) {
    if (fileDescriptor !== null) {
      try {
        fs.closeSync(fileDescriptor);
      } catch (_closeError) {
        // Preserve the original write error.
      }
    }

    try {
      fs.unlinkSync(temporaryPath);
    } catch (_unlinkError) {
      // The temporary file may not have been created or may already have been renamed.
    }

    throw error;
  }
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

function sanitizePublicUrl(value, options = {}) {
  const text = sanitizeText(value, options.maxLength || 500);
  if (!text) return "";
  if (options.allowRelative && /^\/(?!\/)/.test(text)) return text;

  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch (_error) {
    return "";
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sanitizeArticleContent(value) {
  const source = String(value || "").trim();
  const containsHtmlTag = /<\/?[a-z][^>]*>/i.test(source);
  const cleaned = sanitizeHtml(source, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "blockquote",
      "code",
      "pre",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "a",
      "img",
      "hr",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "loading"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      a: ["http", "https", "mailto"],
      img: ["http", "https"],
    },
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    nonTextTags: ["style", "script", "textarea", "option", "noscript"],
    transformTags: {
      a: function transformArticleLink(_tagName, attributes) {
        const nextAttributes = {};
        if (attributes.href) nextAttributes.href = attributes.href;
        if (attributes.title) nextAttributes.title = attributes.title;
        if (attributes.target === "_blank") {
          nextAttributes.target = "_blank";
          nextAttributes.rel = "noopener noreferrer";
        }
        return { tagName: "a", attribs: nextAttributes };
      },
      img: function transformArticleImage(_tagName, attributes) {
        const nextAttributes = { loading: "lazy" };
        if (attributes.src) nextAttributes.src = attributes.src;
        if (attributes.alt) nextAttributes.alt = attributes.alt;
        if (attributes.title) nextAttributes.title = attributes.title;
        return { tagName: "img", attribs: nextAttributes };
      },
    },
  });

  return containsHtmlTag ? cleaned : cleaned.replace(/\r?\n/g, "<br />");
}

function renderArticleSource(source, format) {
  const value = String(source || "").slice(0, MAX_ARTICLE_SOURCE_LENGTH);
  if (format === "markdown") {
    return sanitizeArticleContent(marked.parse(value, { gfm: true, breaks: false }));
  }
  return sanitizeArticleContent(value);
}

function timingSafeStringEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left || ""), "utf8").digest();
  const rightDigest = crypto.createHash("sha256").update(String(right || ""), "utf8").digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function createAdminSessionToken() {
  const now = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      issuedAt: now,
      expiresAt: now + ADMIN_SESSION_TTL_MS,
      nonce: crypto.randomBytes(12).toString("base64url"),
    }),
    "utf8"
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", adminSessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyAdminSessionToken(token) {
  if (!adminAuthReady || typeof token !== "string" || token.length > 2048) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  const expectedSignature = crypto.createHmac("sha256", adminSessionSecret).update(parts[0]).digest("base64url");
  if (!timingSafeStringEqual(parts[1], expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (
      payload.version !== 1 ||
      !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.issuedAt > Date.now() + 60 * 1000 ||
      payload.expiresAt <= Date.now() ||
      payload.expiresAt - payload.issuedAt !== ADMIN_SESSION_TTL_MS
    ) {
      return null;
    }

    return payload;
  } catch (_error) {
    return null;
  }
}

function parseCookies(req) {
  const result = {};
  const cookieHeader = String(req.get("cookie") || "");

  cookieHeader.split(";").forEach((item) => {
    const separatorIndex = item.indexOf("=");
    if (separatorIndex <= 0) return;
    const name = item.slice(0, separatorIndex).trim();
    const rawValue = item.slice(separatorIndex + 1).trim();
    try {
      result[name] = decodeURIComponent(rawValue);
    } catch (_error) {
      result[name] = rawValue;
    }
  });

  return result;
}

function getAdminSession(req) {
  return verifyAdminSessionToken(parseCookies(req)[ADMIN_COOKIE_NAME]);
}

function shouldUseSecureAdminCookie(req) {
  return IS_PRODUCTION || Boolean(req.secure);
}

function serializeAdminCookie(value, req, maxAgeSeconds) {
  const attributes = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "Priority=High",
  ];

  if (shouldUseSecureAdminCookie(req)) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

function requireAdmin(req, res, next) {
  res.setHeader("Cache-Control", "no-store");

  if (!adminAuthReady) {
    res.status(503).json({ message: "站长登录尚未配置。" });
    return;
  }

  const session = getAdminSession(req);
  if (!session) {
    res.status(401).json({ message: "需要站长登录。" });
    return;
  }

  req.adminSession = session;
  next();
}

function capRateMap(map) {
  while (map.size >= MAX_RATE_BUCKETS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function getAdminLoginLock(req) {
  const key = normalizeIp(req.ip);
  const now = Date.now();
  const entry = adminLoginAttempts.get(key);

  if (!entry) {
    return { key, retryAfterSeconds: 0 };
  }

  if (entry.lockedUntil > now) {
    return { key, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
  }

  if (now - entry.windowStartedAt >= ADMIN_LOGIN_WINDOW_MS) {
    adminLoginAttempts.delete(key);
  }

  return { key, retryAfterSeconds: 0 };
}

function recordAdminLoginFailure(key) {
  const now = Date.now();
  let entry = adminLoginAttempts.get(key);

  if (!entry || now - entry.windowStartedAt >= ADMIN_LOGIN_WINDOW_MS) {
    capRateMap(adminLoginAttempts);
    entry = { failures: 0, windowStartedAt: now, lockedUntil: 0 };
    adminLoginAttempts.set(key, entry);
  }

  entry.failures += 1;
  if (entry.failures >= ADMIN_LOGIN_MAX_FAILURES) {
    entry.lockedUntil = now + ADMIN_LOGIN_LOCK_MS;
  }
}

function createCommunityRateLimiter(action, limit) {
  return function communityRateLimiter(req, res, next) {
    const now = Date.now();
    const key = `${action}:${createVisitorFingerprint(req)}`;
    let entry = communityRateBuckets.get(key);

    if (!entry || entry.expiresAt <= now) {
      capRateMap(communityRateBuckets);
      entry = { count: 0, expiresAt: now + COMMUNITY_RATE_WINDOW_MS };
      communityRateBuckets.set(key, entry);
    }

    if (entry.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ message: "操作过于频繁，请稍后再试。" });
      return;
    }

    entry.count += 1;
    next();
  };
}

const limitCommunityPosts = createCommunityRateLimiter("community-post", COMMUNITY_POST_RATE_LIMIT);
const limitCommunityComments = createCommunityRateLimiter("community-comment", COMMUNITY_COMMENT_RATE_LIMIT);

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

function ensureArticleVersions(data) {
  if (!data.articleVersions || typeof data.articleVersions !== "object" || Array.isArray(data.articleVersions)) {
    data.articleVersions = {};
  }

  return data.articleVersions;
}

function ensureMediaAssets(data) {
  if (!Array.isArray(data.mediaAssets)) {
    data.mediaAssets = [];
  }
  return data.mediaAssets;
}

function toPublicMediaAsset(asset) {
  return {
    id: asset.id,
    title: asset.title,
    alt: asset.alt,
    caption: asset.caption,
    url: asset.url,
    largeUrl: asset.largeUrl || asset.url,
    mediumUrl: asset.mediumUrl || asset.url,
    thumbnailUrl: asset.thumbnailUrl || asset.url,
    width: Number(asset.width || 0),
    height: Number(asset.height || 0),
    format: asset.format || "",
    bytes: Number(asset.bytes || 0),
    takenAt: asset.takenAt || asset.createdAt,
    exif: asset.exif || {},
    isPhoto: Boolean(asset.isPhoto),
    status: asset.status === "hidden" ? "hidden" : "published",
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

function getMediaUsage(data, asset) {
  const urls = [asset.url, asset.largeUrl, asset.mediumUrl, asset.thumbnailUrl].filter(Boolean);
  const articles = ensureArticles(data);
  const coverCount = articles.filter((article) => article.coverMediaId === asset.id).length;
  const contentCount = articles.filter((article) =>
    urls.some((url) => String(article.content || "").includes(url) || String(article.source || "").includes(url))
  ).length;
  return { coverCount, contentCount, total: coverCount + contentCount };
}

function attachArticleCover(data, article) {
  if (!article || !article.coverMediaId) return article;
  const asset = ensureMediaAssets(data).find((item) => item.id === article.coverMediaId);
  return asset ? { ...article, cover: toPublicMediaAsset(asset) } : article;
}

function deleteLocalMediaFiles(asset) {
  [asset.url, asset.largeUrl, asset.mediumUrl, asset.thumbnailUrl].filter(Boolean).forEach((url) => {
    try {
      const fileName = path.basename(decodeURIComponent(new URL(url, "http://local.invalid").pathname));
      const filePath = path.resolve(uploadRoot, fileName);
      if (path.dirname(filePath) === uploadRoot && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (_error) {
      // Ignore an already removed or malformed local media path.
    }
  });
}

function getArticleVersionFields(article) {
  return {
    title: article.title,
    excerpt: article.excerpt,
    category: article.category,
    tags: Array.isArray(article.tags) ? [...article.tags] : [],
    date: article.date && typeof article.date === "object" ? article.date.iso : article.date,
    content: article.content,
    source: article.source,
    format: article.format,
    status: article.status,
    publishAt: article.publishAt || null,
    coverMediaId: article.coverMediaId || "",
  };
}

function saveArticleVersion(data, article, reason) {
  const versionsBySlug = ensureArticleVersions(data);
  const versions = Array.isArray(versionsBySlug[article.slug]) ? versionsBySlug[article.slug] : [];
  versions.unshift({
    id: createId("article-version"),
    createdAt: new Date().toISOString(),
    reason: sanitizeText(reason, 40) || "edit",
    snapshot: getArticleVersionFields(article),
  });
  versionsBySlug[article.slug] = versions.slice(0, MAX_ARTICLE_VERSIONS);
}

function moveArticleVersions(data, previousSlug, nextSlug) {
  if (previousSlug === nextSlug) return;
  const versionsBySlug = ensureArticleVersions(data);
  if (Array.isArray(versionsBySlug[previousSlug])) {
    versionsBySlug[nextSlug] = versionsBySlug[previousSlug];
    delete versionsBySlug[previousSlug];
  }
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
  const format = input && input.format === "markdown" ? "markdown" : "html";
  const source = String((input && (input.source ?? input.content)) || "").trim().slice(0, MAX_ARTICLE_SOURCE_LENGTH);
  const content = renderArticleSource(source, format);
  const requestedStatus = sanitizeText(input && input.status, 20);
  const status = ["published", "draft", "scheduled"].includes(requestedStatus) ? requestedStatus : "published";

  if (!title) {
    return { error: "文章标题不能为空。" };
  }

  if (status !== "draft" && !content) {
    return { error: "文章正文不能为空。" };
  }

  const slug = slugify((input && input.slug) || title) || fallbackSlug || createId("article");
  const excerpt =
    sanitizeText(input && input.excerpt, 220) || sanitizeText(stripHtml(content), 220) || "这是一篇新的博客文章。";
  const category = sanitizeText(input && input.category, 40) || "未分类";
  const tags = sanitizeTagList(input && input.tags);
  const coverMediaId = sanitizeText(input && input.coverMediaId, 100);
  const dateValue = sanitizeText(input && input.date, 40) || new Date().toISOString().slice(0, 10);
  const parsedDate = new Date(dateValue);

  if (Number.isNaN(parsedDate.getTime())) {
    return { error: "文章日期格式不正确。" };
  }

  let publishAt = null;
  if (status === "scheduled") {
    const publishAtValue = sanitizeText(input && input.publishAt, 80);
    const parsedPublishAt = new Date(publishAtValue);
    if (!publishAtValue || Number.isNaN(parsedPublishAt.getTime())) {
      return { error: "定时发布需要填写有效的发布时间。" };
    }
    publishAt = parsedPublishAt.toISOString();
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
      source,
      format,
      status,
      publishAt,
      coverMediaId,
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

  if (notes.length > 160) {
    return { error: "单首歌曲最多支持 160 个音符。" };
  }

  const normalized = [];
  let totalBeats = 0;

  for (const note of notes) {
    const frequency = Math.max(0, readNumber(note && note.frequency, 0));
    const beats = Math.max(0.1, readNumber(note && note.beats, 0.5));

    if (frequency > MAX_TRACK_FREQUENCY) {
      return { error: `音符频率不能超过 ${MAX_TRACK_FREQUENCY} Hz。` };
    }

    if (beats > MAX_TRACK_NOTE_BEATS) {
      return { error: `单个音符不能超过 ${MAX_TRACK_NOTE_BEATS} 拍。` };
    }

    totalBeats += beats;
    if (totalBeats > MAX_TRACK_TOTAL_BEATS) {
      return { error: `单首歌曲的音符总拍数不能超过 ${MAX_TRACK_TOTAL_BEATS}。` };
    }

    normalized.push({ frequency, beats });
  }

  return {
    value: normalized,
    totalBeats,
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
  const coverUrl = sanitizeText(input && input.coverUrl, 500) || "";
  const audioUrl = sanitizeText(input && input.audioUrl, 500);
  const bpm = Math.max(40, Math.min(220, Math.round(readNumber(input && input.bpm, 96))));
  const normalizedNotes = normalizeTrackNotes(input);

  if (normalizedNotes.error) {
    return normalizedNotes;
  }

  const synthesizedDurationSeconds = normalizedNotes.totalBeats * (60 / bpm);
  if (synthesizedDurationSeconds > MAX_TRACK_DURATION_SECONDS) {
    return { error: `合成音频总时长不能超过 ${MAX_TRACK_DURATION_SECONDS} 秒。` };
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
      coverUrl,
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

function findStoredPublicArticle(data, slug) {
  const article = ensureArticles(data).find((item) => item.slug === slug) || null;
  return article && isArticlePublic(article) ? article : null;
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

function formatTimelineWeekdayLabel(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("zh-CN", {
    weekday: "short",
    timeZone: "UTC",
  }).format(date);
}

function enrichArticle(article) {
  const format = article.format === "markdown" ? "markdown" : "html";
  const safeArticle = {
    ...article,
    excerpt: String(article.excerpt || ""),
    content: sanitizeArticleContent(article.content || ""),
    source: String(article.source === undefined ? article.content || "" : article.source),
    format,
    status: ["published", "draft", "scheduled"].includes(article.status) ? article.status : "published",
    publishAt: article.publishAt || null,
    category: String(article.category || "未分类"),
    tags: Array.isArray(article.tags) ? article.tags : [],
    likes: Number(article.likes || 0),
  };
  const sourceDate = safeArticle.date && typeof safeArticle.date === "object" ? safeArticle.date.iso : safeArticle.date;
  const date = formatDateParts(sourceDate || new Date().toISOString().slice(0, 10));

  return {
    ...safeArticle,
    date,
  };
}

function toPublicArticle(article) {
  if (!article) return article;
  const {
    likedBy: _likedBy,
    source: _source,
    format: _format,
    status: _status,
    publishAt: _publishAt,
    ...publicArticle
  } = article;
  return publicArticle;
}

function toAdminArticle(article) {
  if (!article) return article;
  const { likedBy: _likedBy, ...adminArticle } = article;
  return adminArticle;
}

function uniqueValues(items) {
  return Array.from(new Set(items)).sort((a, b) => a.localeCompare(b));
}

function isArticlePublic(article, now = Date.now()) {
  const status = article && article.status ? article.status : "published";
  if (status === "draft") return false;
  if (status !== "scheduled") return true;

  const publishAt = new Date(article.publishAt || "").getTime();
  return Number.isFinite(publishAt) && publishAt <= now;
}

function getAllArticles(data) {
  return ensureArticles(data)
    .map(enrichArticle)
    .map((article) => attachArticleCover(data, article))
    .sort((a, b) => b.date.iso.localeCompare(a.date.iso));
}

function getCollections(data) {
  const articles = getAllArticles(data).filter((article) => isArticlePublic(article));
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

function getRequestBaseUrl(req) {
  const configured = String(process.env.PUBLIC_SITE_URL || process.env.SITE_URL || "").trim().replace(/\/+$/, "");
  if (configured) {
    return configured;
  }

  const protocol = req.protocol || "http";
  const host = req.get("host") || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function getArticleUrl(baseUrl, article) {
  return `${baseUrl}/articles/${encodeURIComponent(article.slug)}`;
}

function getArticleDescription(article) {
  return truncateText(article.excerpt || stripHtml(article.content), 180);
}

function getArticleSearchSnippet(article, search) {
  const term = String(search || "").trim().toLowerCase();
  if (!term) return article.excerpt || "";
  const candidates = [String(article.excerpt || ""), stripHtml(article.content || "")];
  const source = candidates.find((value) => value.toLowerCase().includes(term)) || candidates[0];
  const index = source.toLowerCase().indexOf(term);
  if (index < 0) return truncateText(source, 180);
  const start = Math.max(0, index - 70);
  const end = Math.min(source.length, index + term.length + 100);
  return `${start > 0 ? "…" : ""}${source.slice(start, end).trim()}${end < source.length ? "…" : ""}`;
}

function getArticleImageUrl(baseUrl, article) {
  if (article && article.cover && article.cover.largeUrl) {
    return new URL(article.cover.largeUrl, baseUrl).toString();
  }
  const imageMatch = String(article.content || "").match(/<img[^>]+src=["']([^"']+)["']/i);
  if (!imageMatch) {
    return `${baseUrl}/images/avatar.jpg`;
  }

  try {
    return new URL(imageMatch[1], baseUrl).toString();
  } catch (_error) {
    return `${baseUrl}/images/avatar.jpg`;
  }
}

function renderSeoTags({ req, data, pageType, article }) {
  const baseUrl = getRequestBaseUrl(req);
  const siteTitle = data.site && data.site.title ? data.site.title : "Blog";
  const title = article ? `${article.title} | ${siteTitle}` : pageTitle(pageType, null);
  const description = article
    ? getArticleDescription(article)
    : truncateText((data.site && (data.site.tagline || data.site.announcement)) || siteTitle, 180);
  const canonicalPath = article ? `/articles/${encodeURIComponent(article.slug)}` : req.path || "/";
  const canonicalUrl = new URL(canonicalPath, baseUrl).toString();
  const imageUrl = article ? getArticleImageUrl(baseUrl, article) : `${baseUrl}/images/avatar.jpg`;
  const tags = [
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`,
    `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(siteTitle)} RSS" href="${escapeHtml(`${baseUrl}/rss.xml`)}" />`,
    `<meta property="og:type" content="${article ? "article" : "website"}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(siteTitle)}" />`,
    `<meta property="og:image" content="${escapeHtml(imageUrl)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />`,
  ];

  if (pageType === "notFound") {
    tags.push(`<meta name="robots" content="noindex, follow" />`);
  }

  if (article) {
    tags.push(`<meta property="article:published_time" content="${escapeHtml(article.date.iso)}" />`);
    tags.push(`<meta property="article:section" content="${escapeHtml(article.category)}" />`);
    article.tags.forEach((tag) => {
      tags.push(`<meta property="article:tag" content="${escapeHtml(tag)}" />`);
    });
  }

  const jsonLd = article
    ? {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: article.title,
        description,
        datePublished: article.date.iso,
        dateModified: article.date.iso,
        image: [imageUrl],
        mainEntityOfPage: canonicalUrl,
        author: { "@type": "Person", name: data.profile && data.profile.name ? data.profile.name : "Author" },
        publisher: {
          "@type": "Organization",
          name: siteTitle,
          logo: { "@type": "ImageObject", url: `${baseUrl}/images/avatar.jpg` },
        },
      }
    : {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: siteTitle,
        url: baseUrl,
        potentialAction: {
          "@type": "SearchAction",
          target: `${baseUrl}/archive?search={search_term_string}`,
          "query-input": "required name=search_term_string",
        },
      };

  tags.push(`<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`);
  return tags.join("\n    ");
}

function renderServerArticleContent(article) {
  if (!article) {
    return "";
  }

  return (
    `<main class="ssr-article" data-ssr="article">` +
    `<article>` +
    `<h1>${escapeHtml(article.title)}</h1>` +
    `<p>${escapeHtml(article.excerpt)}</p>` +
    `<div>${article.content}</div>` +
    `</article>` +
    `</main>`
  );
}

function renderRssFeed(req) {
  const data = readData();
  const { articles } = getCollections(data);
  const baseUrl = getRequestBaseUrl(req);
  const siteTitle = data.site && data.site.title ? data.site.title : "Blog";
  const description = (data.site && (data.site.tagline || data.site.announcement)) || siteTitle;
  const updatedAt = articles[0] ? new Date(articles[0].date.iso).toUTCString() : new Date().toUTCString();

  const items = articles.slice(0, 30).map((article) => {
    const url = getArticleUrl(baseUrl, article);
    return (
      `<item>` +
      `<title>${escapeXml(article.title)}</title>` +
      `<link>${escapeXml(url)}</link>` +
      `<guid isPermaLink="true">${escapeXml(url)}</guid>` +
      `<pubDate>${new Date(article.date.iso).toUTCString()}</pubDate>` +
      `<category>${escapeXml(article.category)}</category>` +
      `<description>${escapeXml(article.excerpt || stripHtml(article.content))}</description>` +
      `</item>`
    );
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(siteTitle)}</title>
    <link>${escapeXml(baseUrl)}</link>
    <description>${escapeXml(description)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${updatedAt}</lastBuildDate>
    ${items.join("\n    ")}
  </channel>
</rss>`;
}

function renderSitemap(req) {
  const data = readData();
  const { articles } = getCollections(data);
  const baseUrl = getRequestBaseUrl(req);
  const staticPaths = Object.keys(pageMap).filter((item) => item !== "/admin");
  const urls = staticPaths.map((pathname) => ({
    loc: new URL(pathname, baseUrl).toString(),
    lastmod: data.site && data.site.updatedAt ? data.site.updatedAt : new Date().toISOString(),
    priority: pathname === "/" ? "1.0" : "0.7",
  }));

  articles.forEach((article) => {
    urls.push({
      loc: getArticleUrl(baseUrl, article),
      lastmod: article.date.iso,
      priority: "0.8",
    });
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (item) =>
      `  <url><loc>${escapeXml(item.loc)}</loc><lastmod>${escapeXml(item.lastmod)}</lastmod><priority>${item.priority}</priority></url>`
  )
  .join("\n")}
</urlset>`;
}

function renderRobots(req) {
  const baseUrl = getRequestBaseUrl(req);
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /api/",
    `Sitemap: ${baseUrl}/sitemap.xml`,
    "",
  ].join("\n");
}

function buildTimeline(articles) {
  const groups = new Map();

  articles.forEach((article) => {
    const year = Number(article.date.year || 0);
    const month = Number(article.date.month || 0);
    const day = Number(article.date.day || 0);
    const key = String(year);
    const entry = groups.get(key) || {
      key,
      label: String(year),
      year,
      items: [],
    };

    entry.items.push({
      slug: article.slug,
      title: article.title,
      iso: article.date.iso,
      year,
      month,
      day,
      dateLabel: `${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`,
      weekday: formatTimelineWeekdayLabel(year, month, day),
      excerpt: article.excerpt,
      category: article.category,
      tags: Array.isArray(article.tags) ? article.tags.slice(0, 4) : [],
    });

    groups.set(key, entry);
  });

  return Array.from(groups.values())
    .sort((a, b) => b.year - a.year || b.key.localeCompare(a.key))
    .map((group) => ({
      ...group,
      items: group.items.sort((a, b) => String(b.iso || "").localeCompare(String(a.iso || ""))),
    }));
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
    photos: "照片墙",
    community: "社区",
    admin: "后台统计",
    notFound: "404",
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

function renderShell(req, { pageType, articleSlug = null, detailTitle = null }) {
  const data = readData();
  const analytics = ensureAnalytics(data);
  const thirdPartyScript = renderThirdPartyAnalyticsScript(analytics.thirdParty);
  const article = pageType === "article" && articleSlug ? findArticleOrNull(data, articleSlug) : null;
  const seoTags = renderSeoTags({ req, data, pageType, article: article && article.slug ? article : null });
  const ssrContent = article && article.slug ? renderServerArticleContent(article) : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(pageTitle(pageType, detailTitle))}</title>
    ${seoTags}
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
    <div id="app">${ssrContent}</div>
    <script>
      window.__BLOG_STATE__ = ${JSON.stringify({ pageType, articleSlug })};
    </script>
    <script src="/app.js"></script>
  </body>
</html>`;
}

app.use(express.json({ limit: "256kb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.get("/admin.html", (_req, res) => {
  res.redirect(302, "/admin");
});

app.get("/api/admin/session", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (!adminAuthReady) {
    res.status(503).json({ authenticated: false, available: false });
    return;
  }

  const session = getAdminSession(req);
  res.json({
    authenticated: Boolean(session),
    available: true,
    expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
  });
});

app.post("/api/admin/session", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (!adminAuthReady) {
    res.status(503).json({ message: "站长登录尚未配置。" });
    return;
  }

  const lock = getAdminLoginLock(req);
  if (lock.retryAfterSeconds > 0) {
    res.setHeader("Retry-After", String(lock.retryAfterSeconds));
    res.status(429).json({ message: "登录失败，请稍后再试。" });
    return;
  }

  const suppliedPassword = String((req.body && req.body.password) || "");
  if (!timingSafeStringEqual(suppliedPassword, adminPassword)) {
    recordAdminLoginFailure(lock.key);
    res.status(401).json({ message: "登录失败，请检查凭据。" });
    return;
  }

  adminLoginAttempts.delete(lock.key);
  const token = createAdminSessionToken();
  const session = verifyAdminSessionToken(token);
  res.setHeader("Set-Cookie", serializeAdminCookie(token, req, ADMIN_SESSION_TTL_MS / 1000));
  res.json({
    authenticated: true,
    available: true,
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
});

app.delete("/api/admin/session", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", serializeAdminCookie("", req, 0));
  res.json({ ok: true, authenticated: false });
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(assetRoots.images));
app.use("/videos", express.static(assetRoots.videos));
app.use("/uploads", express.static(uploadRoot, { fallthrough: true, maxAge: IS_PRODUCTION ? "7d" : 0 }));

app.use((req, _res, next) => {
  if (shouldTrackPageRequest(req)) {
    recordPageVisit(req);
  }
  next();
});

app.get("/healthz", (_req, res) => {
  try {
    readData();
    res.json({ ok: true });
  } catch (_error) {
    res.status(503).json({ ok: false, message: "Site data is unavailable." });
  }
});

app.get("/rss.xml", (req, res) => {
  res.type("application/rss+xml").send(renderRssFeed(req));
});

app.get("/sitemap.xml", (req, res) => {
  res.type("application/xml").send(renderSitemap(req));
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(renderRobots(req));
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

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const data = readData();
  const { articles } = getCollections(data);
  res.json(getAdminStats(data, articles));
});

app.get("/api/photos", (_req, res) => {
  const data = readData();
  const items = ensureMediaAssets(data)
    .filter((asset) => asset.isPhoto && asset.status !== "hidden")
    .map(toPublicMediaAsset)
    .sort((left, right) => String(right.takenAt || "").localeCompare(String(left.takenAt || "")));
  res.json({ items, total: items.length });
});

app.get("/api/admin/media", requireAdmin, (_req, res) => {
  const data = readData();
  res.json({
    items: ensureMediaAssets(data).map((asset) => ({
      ...toPublicMediaAsset(asset),
      usage: getMediaUsage(data, asset),
    })),
  });
});

app.put("/api/admin/settings", requireAdmin, (req, res) => {
  const data = readData();
  const input = req.body || {};
  data.site = data.site && typeof data.site === "object" ? data.site : {};
  data.profile = data.profile && typeof data.profile === "object" ? data.profile : {};
  data.site.title = sanitizeText(input.title, 80) || data.site.title || "朝花夕拾";
  data.site.tagline = sanitizeText(input.tagline, 180);
  data.site.announcement = sanitizeText(input.announcement, 500);
  data.site.copyright = sanitizeText(input.copyright, 180);
  data.site.updatedAt = new Date().toISOString();
  data.profile.name = sanitizeText(input.name, 80) || data.profile.name || "站长";
  data.profile.bio = sanitizeText(input.bio, 240);
  data.profile.about = sanitizeText(input.about, 3000);
  data.profile.avatar = sanitizePublicUrl(input.avatar, { allowRelative: true }) || "/images/avatar.jpg";
  data.profile.socials = [
    { label: "GitHub", icon: "fa-brands fa-github", url: sanitizePublicUrl(input.github) },
    { label: "Weibo", icon: "fa-brands fa-weibo", url: sanitizePublicUrl(input.weibo) },
    { label: "TikTok", icon: "fa-brands fa-tiktok", url: sanitizePublicUrl(input.douyin) },
  ].filter((item) => item.url);
  writeData(data);
  res.json({ ok: true, site: data.site, profile: data.profile });
});

app.get("/api/admin/articles", requireAdmin, (_req, res) => {
  const data = readData();
  res.json({ items: getAllArticles(data).map(toAdminArticle) });
});

app.post("/api/admin/articles/preview", requireAdmin, (req, res) => {
  const format = req.body && req.body.format === "markdown" ? "markdown" : "html";
  const source = String((req.body && req.body.content) || "").slice(0, MAX_ARTICLE_SOURCE_LENGTH);
  res.json({ html: renderArticleSource(source, format) });
});

app.post("/api/admin/uploads", requireAdmin, acceptImageUpload, async (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: "请选择需要上传的图片。" });
    return;
  }

  try {
    const data = readData();
    const asset = await processUploadedImage(req.file);
    asset.isPhoto = String(req.body && req.body.isPhoto) === "true";
    asset.status = String(req.body && req.body.status) === "hidden" ? "hidden" : "published";
    ensureMediaAssets(data).unshift(asset);
    writeData(data);
    res.status(201).json({
      url: asset.url,
      name: path.basename(req.file.originalname || "image"),
      size: asset.bytes,
      item: toPublicMediaAsset(asset),
    });
  } catch (error) {
    res.status(400).json({ message: error.message || "图片处理失败。" });
  }
});

app.put("/api/admin/media/:id", requireAdmin, (req, res) => {
  const data = readData();
  const asset = ensureMediaAssets(data).find((item) => item.id === req.params.id);
  if (!asset) {
    res.status(404).json({ message: "Media not found." });
    return;
  }

  asset.title = sanitizeText(req.body && req.body.title, 120) || asset.title;
  asset.alt = sanitizeText(req.body && req.body.alt, 160) || asset.alt;
  asset.caption = sanitizeText(req.body && req.body.caption, 500);
  const takenAt = normalizeExifDate(req.body && req.body.takenAt);
  if (takenAt) asset.takenAt = takenAt;
  asset.isPhoto = Boolean(req.body && req.body.isPhoto);
  asset.status = req.body && req.body.status === "hidden" ? "hidden" : "published";
  asset.updatedAt = new Date().toISOString();
  writeData(data);
  res.json({ item: { ...toPublicMediaAsset(asset), usage: getMediaUsage(data, asset) } });
});

app.delete("/api/admin/media/:id", requireAdmin, (req, res) => {
  const data = readData();
  const assets = ensureMediaAssets(data);
  const index = assets.findIndex((item) => item.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ message: "Media not found." });
    return;
  }

  const usage = getMediaUsage(data, assets[index]);
  if (usage.total > 0) {
    res.status(409).json({ message: "图片仍被文章引用，请先移除封面或正文引用。", usage });
    return;
  }

  const [asset] = assets.splice(index, 1);
  deleteLocalMediaFiles(asset);
  writeData(data);
  res.json({ ok: true });
});

app.get("/api/admin/articles/:slug/versions", requireAdmin, (req, res) => {
  const data = readData();
  const article = ensureArticles(data).find((item) => item.slug === req.params.slug);
  if (!article) {
    res.status(404).json({ message: "Article not found." });
    return;
  }

  const versionsBySlug = ensureArticleVersions(data);
  const versions = Array.isArray(versionsBySlug[article.slug]) ? versionsBySlug[article.slug] : [];
  res.json({
    items: versions.map((version) => ({
      id: version.id,
      createdAt: version.createdAt,
      reason: version.reason,
      title: version.snapshot && version.snapshot.title,
      status: version.snapshot && version.snapshot.status,
    })),
  });
});

app.post("/api/admin/articles/:slug/versions/:versionId/restore", requireAdmin, (req, res) => {
  const data = readData();
  const article = ensureArticles(data).find((item) => item.slug === req.params.slug);
  if (!article) {
    res.status(404).json({ message: "Article not found." });
    return;
  }

  const versionsBySlug = ensureArticleVersions(data);
  const versions = Array.isArray(versionsBySlug[article.slug]) ? versionsBySlug[article.slug] : [];
  const version = versions.find((item) => item.id === req.params.versionId);
  if (!version || !version.snapshot) {
    res.status(404).json({ message: "Version not found." });
    return;
  }

  saveArticleVersion(data, article, "before-restore");
  Object.assign(article, version.snapshot, { updatedAt: new Date().toISOString() });
  writeData(data);
  res.json({ item: toAdminArticle(enrichArticle(article)) });
});

app.get("/api/articles", (req, res) => {
  const data = readData();
  const { articles } = getCollections(data);
  const selectedDate = req.query.date;
  const selectedCategory = req.query.category;
  const selectedTag = req.query.tag;
  const search = String(req.query.search || "").trim().toLowerCase();
  const requestedPage = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  const rawLimit = Number.parseInt(String(req.query.limit || "0"), 10) || 0;
  const requestedLimit = Math.min(Math.max(rawLimit, 0), MAX_ARTICLE_PAGE_SIZE);

  const filtered = articles.filter((article) => {
    if (selectedDate && article.date.iso !== selectedDate) return false;
    if (selectedCategory && article.category !== selectedCategory) return false;
    if (selectedTag && !article.tags.includes(selectedTag)) return false;
    if (!search) return true;

    return (
      article.title.toLowerCase().includes(search) ||
      article.excerpt.toLowerCase().includes(search) ||
      article.tags.join(" ").toLowerCase().includes(search) ||
      stripHtml(article.content).toLowerCase().includes(search)
    );
  });
  const pageSize = requestedLimit || filtered.length || DEFAULT_ARTICLE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const start = requestedLimit ? (page - 1) * pageSize : 0;
  const items = requestedLimit ? filtered.slice(start, start + pageSize) : filtered;

  res.json({
    items: items.map((article) => ({
      ...toPublicArticle(article),
      ...(search ? { searchSnippet: getArticleSearchSnippet(article, search) } : {}),
    })),
    total: filtered.length,
    pagination: {
      page,
      limit: pageSize,
      total: filtered.length,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  });
});

app.post("/api/articles", requireAdmin, (req, res) => {
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  articles.unshift(article);
  saveArticleVersion(data, article, "create");
  writeData(data);
  res.status(201).json({ item: toAdminArticle(enrichArticle(article)) });
});

app.get("/api/articles/:slug", (req, res) => {
  const data = readData();
  const article = findArticleOrNull(data, req.params.slug);

  if (!article) {
    res.status(404).json({ message: "Article not found" });
    return;
  }

  res.json(toPublicArticle(decorateArticle(article, createVisitorFingerprint(req))));
});

app.put("/api/articles/:slug", requireAdmin, (req, res) => {
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

  saveArticleVersion(data, article, "edit");
  Object.assign(article, normalized.value, {
    likes: preservedLikes,
    likedBy: preservedLikedBy,
    updatedAt: new Date().toISOString(),
  });

  if (previousSlug !== article.slug && Array.isArray(articleComments[previousSlug])) {
    articleComments[article.slug] = articleComments[previousSlug];
    delete articleComments[previousSlug];
  }

  moveArticleVersions(data, previousSlug, article.slug);

  writeData(data);
  res.json({ item: toAdminArticle(enrichArticle(article)) });
});

app.delete("/api/articles/:slug", requireAdmin, (req, res) => {
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
  delete ensureArticleVersions(data)[req.params.slug];
  articles.splice(articleIndex, 1);
  writeData(data);
  res.json({ ok: true });
});

app.post("/api/articles/:slug/like", (req, res) => {
  const data = readData();
  const article = findStoredPublicArticle(data, req.params.slug);
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

app.post("/api/playlist", requireAdmin, (req, res) => {
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

app.put("/api/playlist/:id", requireAdmin, (req, res) => {
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

app.delete("/api/playlist/:id", requireAdmin, (req, res) => {
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

const { searchSongs, proxyAudio, proxyImage } = require("./services/netease");

app.get("/api/netease/search", requireAdmin, async (req, res) => {
  try {
    const keyword = String(req.query.keyword || "").trim();
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));

    if (!keyword) {
      res.status(400).json({ message: "请输入搜索关键词" });
      return;
    }

    const songs = await searchSongs(keyword, limit);
    res.json({ items: songs });
  } catch (error) {
    console.error("[NetEase] Search route error:", error.message);
    res.status(500).json({ message: "搜索失败，请稍后重试" });
  }
});

app.get("/api/netease/audio/:id", (req, res) => {
  proxyAudio(req.params.id, req, res);
});

app.get("/api/netease/cover", (req, res) => {
  const imageUrl = String(req.query.url || "").trim();
  proxyImage(imageUrl, req, res);
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
    trackId: sanitizeText(req.body && req.body.trackId, 80),
    currentTime: Math.max(0, readNumber(req.body && req.body.currentTime, 0)),
    playing: Boolean(req.body && req.body.playing),
    volume: Math.max(0, Math.min(1, readNumber(req.body && req.body.volume, 0.75))),
    playlistOpen: Boolean(req.body && req.body.playlistOpen),
    playMode: ["order", "repeat-all", "repeat-one", "shuffle"].includes(req.body && req.body.playMode)
      ? req.body.playMode
      : "repeat-all",
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

app.post("/api/community/posts", limitCommunityPosts, (req, res) => {
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

app.delete("/api/community/posts/:postId", requireAdmin, (req, res) => {
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

app.post("/api/community/posts/:postId/comments", limitCommunityComments, (req, res) => {
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

app.delete("/api/community/posts/:postId/comments/:commentId", requireAdmin, (req, res) => {
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
  res.status(403).json({ message: "文章评论已关闭，请前往社区留言。" });
});

app.delete("/api/articles/:slug/comments/:commentId", requireAdmin, (req, res) => {
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

app.delete("/api/articles/:slug/comments/:commentId/replies/:replyId", requireAdmin, (req, res) => {
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
  res.status(403).json({ message: "文章评论互动已关闭，请前往社区留言。" });
});

app.post("/api/articles/:slug/comments/:commentId/replies/:replyId/like", (req, res) => {
  res.status(403).json({ message: "文章评论互动已关闭，请前往社区留言。" });
});

app.get(Object.keys(pageMap), (req, res) => {
  res.send(renderShell(req, { pageType: pageMap[req.path] }));
});

app.get("/articles/:slug", (req, res) => {
  const data = readData();
  const article = findArticleOrNull(data, req.params.slug);

  if (!article) {
    res.status(404).send(renderShell(req, { pageType: "notFound" }));
    return;
  }

  res.send(renderShell(req, { pageType: "article", articleSlug: article.slug, detailTitle: article.title }));
});

app.use((req, res) => {
  if (req.method !== "GET") {
    res.status(404).json({ message: "Not found." });
    return;
  }

  res.status(404).send(renderShell(req, { pageType: "notFound" }));
});

app.listen(PORT, () => {
  console.log(`Full-stack blog is running on port ${PORT}`);
});
