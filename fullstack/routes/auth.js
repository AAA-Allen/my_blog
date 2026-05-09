const express = require("express");
const pool = require("../db");
const { buildAuthorizeUrl, exchangeCodeForProfile } = require("../services/qq-auth");

const router = express.Router();

async function upsertQQUser(profile, defaultRole) {
  const [rows] = await pool.query("SELECT * FROM users WHERE qq_openid = ? LIMIT 1", [profile.openid]);

  if (rows.length) {
    const user = rows[0];
    await pool.query(
      "UPDATE users SET username = ?, avatar_url = ?, updated_at = NOW() WHERE id = ?",
      [profile.username, profile.avatarUrl, user.id]
    );

    return {
      id: user.id,
      qq_openid: user.qq_openid,
      username: profile.username,
      avatar_url: profile.avatarUrl,
      role: user.role,
    };
  }

  const [countRows] = await pool.query("SELECT COUNT(*) AS total FROM users");
  const role = defaultRole || (Number(countRows[0].total || 0) === 0 ? "admin" : "user");
  const [result] = await pool.query(
    "INSERT INTO users (qq_openid, username, avatar_url, role, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())",
    [profile.openid, profile.username, profile.avatarUrl, role]
  );

  return {
    id: result.insertId,
    qq_openid: profile.openid,
    username: profile.username,
    avatar_url: profile.avatarUrl,
    role,
  };
}

router.get("/me", (req, res) => {
  res.json({ user: req.session && req.session.user ? req.session.user : null });
});

router.get("/qq/login", (req, res, next) => {
  try {
    res.redirect(buildAuthorizeUrl(req.query.state || ""));
  } catch (error) {
    next(error);
  }
});

router.get("/qq/callback", async (req, res, next) => {
  try {
    const code = String(req.query.code || "").trim();
    if (!code) {
      return res.status(400).send("Missing code");
    }

    const profile = await exchangeCodeForProfile(code);
    const user = await upsertQQUser(profile);
    req.session.user = user;
    res.redirect("/dashboard");
  } catch (error) {
    next(error);
  }
});

router.post("/logout", (req, res) => {
  if (!req.session) {
    return res.json({ ok: true });
  }

  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.post("/dev-login", async (req, res, next) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ message: "Not found" });
  }

  try {
    const profile = {
      openid: "dev-local-admin",
      username: "本地管理员",
      avatarUrl: "/images/avatar.jpg",
    };
    const user = await upsertQQUser(profile, "admin");
    req.session.user = user;
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
