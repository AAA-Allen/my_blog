const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const multer = require("multer");
const { Parser } = require("json2csv");
const pool = require("../db");
const { requireLogin, requireRole } = require("../middleware/auth");
const { importArticleFromFile, renderEditorContent } = require("../services/article-import");

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, "..", "uploads", "temp") });

function slugify(value) {
  return String(value || "")
    .trim()
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

function parseTagsInput(value) {
  return String(value || "")
    .split(/[，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

async function ensureCategoryId(name) {
  const value = String(name || "").trim();
  if (!value) {
    return null;
  }

  const [rows] = await pool.query("SELECT id FROM categories WHERE name = ? LIMIT 1", [value]);
  if (rows.length) {
    return rows[0].id;
  }

  const [result] = await pool.query("INSERT INTO categories (name, created_at) VALUES (?, NOW())", [value]);
  return result.insertId;
}

async function syncTags(postId, tags) {
  await pool.query("DELETE FROM post_tags WHERE post_id = ?", [postId]);

  for (const tagName of tags) {
    const name = String(tagName || "").trim();
    if (!name) {
      continue;
    }

    const [rows] = await pool.query("SELECT id FROM tags WHERE name = ? LIMIT 1", [name]);
    let tagId = rows.length ? rows[0].id : null;

    if (!tagId) {
      const [result] = await pool.query("INSERT INTO tags (name, created_at) VALUES (?, NOW())", [name]);
      tagId = result.insertId;
    }

    await pool.query("INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)", [postId, tagId]);
  }
}

function normalizePostPayload(body) {
  const title = String(body.title || "").trim();
  const slug = slugify(body.slug || title);
  const contentMarkdown = String(body.contentMarkdown || "").trim();
  const contentHtml = String(body.contentHtml || "").trim() || renderEditorContent(contentMarkdown);
  const excerpt = String(body.excerpt || "").trim() || stripHtml(contentHtml).slice(0, 180);
  const category = String(body.category || "").trim();
  const status = body.status === "published" ? "published" : "draft";
  const tags = parseTagsInput(body.tags);

  if (!title) {
    return { error: "文章标题不能为空。" };
  }

  if (!slug) {
    return { error: "Slug 不能为空。" };
  }

  if (!contentMarkdown && !contentHtml) {
    return { error: "文章正文不能为空。" };
  }

  return {
    value: {
      title,
      slug,
      excerpt,
      category,
      status,
      tags,
      contentMarkdown,
      contentHtml,
    },
  };
}

router.use(requireLogin);

router.get("/posts", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || "").trim();
    const status = String(req.query.status || "").trim();
    const category = String(req.query.category || "").trim();
    let sql = `
      SELECT
        p.id,
        p.author_id,
        p.slug,
        p.title,
        p.excerpt,
        p.content_html,
        p.content_markdown,
        p.status,
        p.view_count,
        p.like_count,
        p.comment_count,
        p.created_at,
        p.updated_at,
        u.username,
        c.name AS category_name,
        GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ',') AS tags_csv
      FROM posts p
      LEFT JOIN users u ON u.id = p.author_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN post_tags pt ON pt.post_id = p.id
      LEFT JOIN tags t ON t.id = pt.tag_id
      WHERE 1 = 1
    `;
    const params = [];

    if (keyword) {
      sql += " AND (p.title LIKE ? OR p.excerpt LIKE ? OR p.slug LIKE ?)";
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    if (status) {
      sql += " AND p.status = ?";
      params.push(status);
    }

    if (category) {
      sql += " AND c.name = ?";
      params.push(category);
    }

    sql += " GROUP BY p.id ORDER BY p.created_at DESC";

    const [rows] = await pool.query(sql, params);
    res.json({
      items: rows.map((item) => ({
        ...item,
        tags: item.tags_csv ? String(item.tags_csv).split(",") : [],
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/posts", requireRole("admin", "editor"), async (req, res, next) => {
  const connection = await pool.getConnection();

  try {
    const normalized = normalizePostPayload(req.body || {});
    if (normalized.error) {
      return res.status(400).json({ message: normalized.error });
    }

    const [existingRows] = await connection.query("SELECT id FROM posts WHERE slug = ? LIMIT 1", [normalized.value.slug]);
    if (existingRows.length) {
      return res.status(409).json({ message: "Slug 已存在，请更换后再试。" });
    }

    const categoryId = await ensureCategoryId(normalized.value.category);

    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO posts (
        author_id, category_id, slug, title, excerpt, content_html, content_markdown, source_type, status,
        cover_image, view_count, like_count, comment_count, created_at, updated_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'editor', ?, '', 0, 0, 0, NOW(), NOW(), ?)` ,
      [
        req.currentUser.id,
        categoryId,
        normalized.value.slug,
        normalized.value.title,
        normalized.value.excerpt,
        normalized.value.contentHtml,
        normalized.value.contentMarkdown || null,
        normalized.value.status,
        normalized.value.status === "published" ? new Date() : null,
      ]
    );

    await syncTags(result.insertId, normalized.value.tags);
    await connection.commit();

    res.status(201).json({ ok: true, id: result.insertId });
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    next(error);
  } finally {
    connection.release();
  }
});

router.put("/posts/:id", requireRole("admin", "editor"), async (req, res, next) => {
  const connection = await pool.getConnection();

  try {
    const postId = Number(req.params.id);
    const normalized = normalizePostPayload(req.body || {});
    if (normalized.error) {
      return res.status(400).json({ message: normalized.error });
    }

    const [duplicateRows] = await connection.query("SELECT id FROM posts WHERE slug = ? AND id <> ? LIMIT 1", [normalized.value.slug, postId]);
    if (duplicateRows.length) {
      return res.status(409).json({ message: "Slug 已存在，请更换后再试。" });
    }

    const categoryId = await ensureCategoryId(normalized.value.category);

    await connection.beginTransaction();
    const [result] = await connection.query(
      `UPDATE posts
       SET category_id = ?, slug = ?, title = ?, excerpt = ?, content_html = ?, content_markdown = ?, status = ?, updated_at = NOW(),
           published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN NOW() ELSE published_at END
       WHERE id = ?`,
      [
        categoryId,
        normalized.value.slug,
        normalized.value.title,
        normalized.value.excerpt,
        normalized.value.contentHtml,
        normalized.value.contentMarkdown || null,
        normalized.value.status,
        normalized.value.status,
        postId,
      ]
    );

    if (!result.affectedRows) {
      await connection.rollback();
      return res.status(404).json({ message: "文章不存在。" });
    }

    await syncTags(postId, normalized.value.tags);
    await connection.commit();

    res.json({ ok: true, id: postId });
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    next(error);
  } finally {
    connection.release();
  }
});

router.delete("/posts/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    await pool.query("DELETE FROM posts WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/posts/import", requireRole("admin", "editor"), upload.single("file"), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ message: "请选择要上传的文件。" });
  }

  try {
    const result = await importArticleFromFile(req.file.path, req.file.originalname);
    res.json(result);
  } catch (error) {
    next(error);
  } finally {
    await fs.unlink(req.file.path).catch(() => undefined);
  }
});

router.get("/users", requireRole("admin"), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, qq_openid, username, avatar_url, role, created_at, updated_at FROM users ORDER BY created_at DESC"
    );
    res.json({ items: rows });
  } catch (error) {
    next(error);
  }
});

router.put("/users/:id/role", requireRole("admin"), async (req, res, next) => {
  try {
    const role = ["admin", "editor", "user"].includes(req.body && req.body.role) ? req.body.role : "";
    if (!role) {
      return res.status(400).json({ message: "角色不正确。" });
    }

    await pool.query("UPDATE users SET role = ?, updated_at = NOW() WHERE id = ?", [role, req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/stats", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const range = ["day", "week", "month"].includes(req.query.range) ? req.query.range : "day";
    const [rows] = await pool.query(
      "SELECT stat_date, stat_type, view_count, comment_count, like_count FROM analytics_daily WHERE stat_type = ? ORDER BY stat_date DESC LIMIT 90",
      [range]
    );
    res.json({ items: rows });
  } catch (error) {
    next(error);
  }
});

router.get("/stats/export", requireRole("admin"), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT stat_date, stat_type, view_count, comment_count, like_count FROM analytics_daily ORDER BY stat_date DESC"
    );
    const parser = new Parser({ fields: ["stat_date", "stat_type", "view_count", "comment_count", "like_count"] });
    const csv = parser.parse(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=dashboard-stats.csv");
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

router.post("/stats/reset", requireRole("admin"), async (req, res, next) => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.query("UPDATE posts SET view_count = 0, like_count = 0, comment_count = 0");
    await connection.query("UPDATE comments SET like_count = 0");
    await connection.query("DELETE FROM comment_likes");
    await connection.query("DELETE FROM post_likes");
    await connection.query("DELETE FROM analytics_daily");
    await connection.query(
      "INSERT INTO stat_reset_logs (reset_by, reset_target, created_at) VALUES (?, 'all', NOW())",
      [req.currentUser.id]
    );
    await connection.commit();
    res.json({ ok: true });
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    next(error);
  } finally {
    connection.release();
  }
});

router.get("/posts/:postId/comments", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         c.id,
         c.post_id,
         c.user_id,
         c.parent_id,
         c.reply_to_user_id,
         c.content,
         c.like_count,
         c.created_at,
         c.updated_at,
         u.username,
         u.avatar_url,
         ru.username AS reply_to_username
       FROM comments c
       INNER JOIN users u ON u.id = c.user_id
       LEFT JOIN users ru ON ru.id = c.reply_to_user_id
       WHERE c.post_id = ?
       ORDER BY c.created_at ASC`,
      [req.params.postId]
    );

    res.json({ items: rows });
  } catch (error) {
    next(error);
  }
});

router.delete("/comments/:id", requireRole("admin", "editor"), async (req, res, next) => {
  try {
    await pool.query("DELETE FROM comments WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
