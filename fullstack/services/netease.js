const https = require("https");
const http = require("http");
const dns = require("dns");
const net = require("net");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const API_TIMEOUT_MS = 8000;
const API_MAX_BYTES = 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10000;
const IMAGE_TOTAL_TIMEOUT_MS = 15000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MAX_REDIRECTS = 3;
const SAFE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const TRUSTED_IMAGE_HOST_SUFFIXES = ["music.126.net", "music.163.com"];

function apiRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      let size = 0;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        size += Buffer.byteLength(chunk, "utf8");
        if (size > API_MAX_BYTES) {
          res.destroy(new Error("NetEase response is too large"));
          return;
        }
        data += chunk;
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Invalid JSON response from NetEase"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(API_TIMEOUT_MS, () => req.destroy(new Error("NetEase request timed out")));
    if (body) req.write(body);
    req.end();
  });
}

async function searchSongs(keyword, limit = 10) {
  const body = `s=${encodeURIComponent(keyword)}&type=1&limit=${limit}&offset=0`;
  try {
    const result = await apiRequest(
      {
        hostname: "music.163.com",
        path: "/api/search/get",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://music.163.com/",
          Cookie: "appver=2.0.2",
          "User-Agent": UA,
        },
      },
      body
    );

    if (result.code === 200 && result.result && result.result.songs) {
      return result.result.songs.map((song) => {
        const picUrl = song.album && song.album.picUrl ? song.album.picUrl : "";
        const albumId = song.album ? String(song.album.id) : "";
        return {
          id: String(song.id),
          name: song.name,
          artists: (song.artists || []).map((a) => a.name),
          artist: (song.artists || []).map((a) => a.name).join(" / "),
          album: song.album ? song.album.name : "",
          albumId,
          coverUrl: picUrl,
          duration: song.duration || 0,
          durationText: formatDuration(song.duration || 0),
        };
      });
    }
    return [];
  } catch (error) {
    console.error("[NetEase] Search error:", error.message);
    return [];
  }
}

async function getSongUrl(songId) {
  const strategies = [
    { path: "/api/song/enhance/player/url", method: "POST", body: `id=${songId}&ids=[${songId}]&br=320000` },
    { path: "/api/song/enhance/player/url", method: "POST", body: `id=${songId}&ids=[${songId}]&br=128000` },
    { path: `/api/song/url?id=${songId}&br=320000`, method: "GET" },
    { path: `/api/song/url?id=${songId}&br=128000`, method: "GET" },
  ];

  for (const strategy of strategies) {
    try {
      const result = await apiRequest(
        {
          hostname: "music.163.com",
          path: strategy.path,
          method: strategy.method,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: "https://music.163.com/",
            Cookie: "appver=2.0.2; os=pc; osver=windows",
            "User-Agent": UA,
          },
        },
        strategy.body || undefined
      );

      if (result.code === 200 && result.data && result.data[0]) {
        const data = result.data[0];
        if (data.url && data.url.length > 10) {
          return data.url;
        }
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

function isUsableAudioResponse(response) {
  const statusCode = response.statusCode || 0;
  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  return (
    (statusCode === 200 || statusCode === 206) &&
    (contentType.startsWith("audio/") || contentType.includes("application/octet-stream"))
  );
}

function proxyAudio(songId, req, res) {
  const rangeHeader = req.headers.range || "";
  let responded = false;

  function sendUnavailable() {
    if (responded) return;
    responded = true;
    const body = Buffer.from(JSON.stringify({ message: "Audio source is unavailable." }), "utf8");
    res.writeHead(404, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "X-Audio-Unavailable",
      "X-Audio-Unavailable": "1",
    });
    res.end(body);
  }

  getSongUrl(songId)
    .then((audioUrl) => {
      if (!audioUrl) {
        sendUnavailable();
        return;
      }

      const parsedUrl = new URL(audioUrl);
      const isHttps = parsedUrl.protocol === "https:";
      const mod = isHttps ? https : http;

      const proxyHeaders = {
        Referer: "https://music.163.com/",
        "User-Agent": UA,
      };

      if (rangeHeader) {
        proxyHeaders.Range = rangeHeader;
      }

      const proxyReq = mod.get(audioUrl, { headers: proxyHeaders }, (audioRes) => {
        const statusCode = audioRes.statusCode || 200;

        if (statusCode >= 300 && statusCode < 400 && audioRes.headers.location) {
          const redirectUrl = new URL(audioRes.headers.location, audioUrl);
          const redirectMod = redirectUrl.protocol === "https:" ? https : http;
          redirectMod.get(
            redirectUrl.toString(),
            {
              headers: {
                Referer: "https://music.163.com/",
                "User-Agent": UA,
                ...(rangeHeader ? { Range: rangeHeader } : {}),
              },
            },
            (redirectRes) => {
              if (!isUsableAudioResponse(redirectRes)) {
                redirectRes.resume();
                sendUnavailable();
                return;
              }
              if (responded) return;
              responded = true;
              const finalHeaders = {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Expose-Headers": "Content-Length, Content-Range",
              };
              if (redirectRes.headers["content-type"]) finalHeaders["Content-Type"] = redirectRes.headers["content-type"];
              if (redirectRes.headers["content-length"]) finalHeaders["Content-Length"] = redirectRes.headers["content-length"];
              if (redirectRes.headers["content-range"]) finalHeaders["Content-Range"] = redirectRes.headers["content-range"];
              if (redirectRes.headers["accept-ranges"]) finalHeaders["Accept-Ranges"] = redirectRes.headers["accept-ranges"];

              res.writeHead(redirectRes.statusCode || 200, finalHeaders);
              redirectRes.pipe(res);
              redirectRes.on("error", () => res.end());
            }
          ).on("error", () => sendUnavailable());
          return;
        }

        if (!isUsableAudioResponse(audioRes)) {
          audioRes.resume();
          sendUnavailable();
          return;
        }

        if (responded) return;
        responded = true;
        const responseHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "Content-Length, Content-Range",
        };
        if (audioRes.headers["content-type"]) responseHeaders["Content-Type"] = audioRes.headers["content-type"];
        if (audioRes.headers["content-length"]) responseHeaders["Content-Length"] = audioRes.headers["content-length"];
        if (audioRes.headers["content-range"]) responseHeaders["Content-Range"] = audioRes.headers["content-range"];
        if (audioRes.headers["accept-ranges"]) responseHeaders["Accept-Ranges"] = audioRes.headers["accept-ranges"];

        res.writeHead(statusCode, responseHeaders);
        audioRes.pipe(res);
        audioRes.on("error", () => res.end());
      });

      proxyReq.setTimeout(15000, () => proxyReq.destroy(new Error("Audio proxy timed out")));
      proxyReq.on("error", () => sendUnavailable());
    })
    .catch((error) => {
      console.error("[NetEase] Proxy error:", error.message);
      sendUnavailable();
    });
}

function isTrustedImageHost(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return TRUSTED_IMAGE_HOST_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function isPublicIp(address) {
  const normalized = String(address || "").toLowerCase();

  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    const [a, b] = parts;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }

  if (net.isIPv6(normalized)) {
    if (normalized === "::" || normalized === "::1") return false;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return false;
    if (normalized.startsWith("::ffff:")) return isPublicIp(normalized.slice(7));
    return true;
  }

  return false;
}

async function validateImageUrl(value) {
  const parsedUrl = value instanceof URL ? value : new URL(value);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error("Unsupported image protocol");
  if (parsedUrl.username || parsedUrl.password) throw new Error("Image credentials are not allowed");
  if (!isTrustedImageHost(parsedUrl.hostname)) throw new Error("Image host is not allowed");
  if (parsedUrl.port && !((parsedUrl.protocol === "https:" && parsedUrl.port === "443") || (parsedUrl.protocol === "http:" && parsedUrl.port === "80"))) {
    throw new Error("Image port is not allowed");
  }

  const addresses = await dns.promises.lookup(parsedUrl.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new Error("Image host resolved to a non-public address");
  }

  return parsedUrl;
}

async function fetchTrustedImage(value, redirectCount, deadline) {
  if (Date.now() >= deadline) throw new Error("Image request timed out");
  const parsedUrl = await validateImageUrl(value);

  return new Promise((resolve, reject) => {
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const request = transport.get(
      parsedUrl,
      {
        headers: {
          Referer: "https://music.163.com/",
          "User-Agent": UA,
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
        },
      },
      (upstream) => {
        const statusCode = upstream.statusCode || 502;
        if (statusCode >= 300 && statusCode < 400 && upstream.headers.location) {
          upstream.resume();
          if (redirectCount >= IMAGE_MAX_REDIRECTS) {
            reject(new Error("Too many image redirects"));
            return;
          }

          const redirectUrl = new URL(upstream.headers.location, parsedUrl);
          fetchTrustedImage(redirectUrl, redirectCount + 1, deadline).then(resolve, reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          upstream.resume();
          reject(new Error(`Image upstream returned ${statusCode}`));
          return;
        }

        const contentType = String(upstream.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        const contentLength = Number(upstream.headers["content-length"] || 0);
        if (!SAFE_IMAGE_TYPES.has(contentType) || (contentLength && contentLength > IMAGE_MAX_BYTES)) {
          upstream.resume();
          reject(new Error("Unsafe image response"));
          return;
        }

        const chunks = [];
        let size = 0;
        upstream.on("data", (chunk) => {
          size += chunk.length;
          if (size > IMAGE_MAX_BYTES) {
            upstream.destroy(new Error("Image response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        upstream.on("error", reject);
        upstream.on("end", () => resolve({ contentType, body: Buffer.concat(chunks, size) }));
      }
    );

    const remaining = Math.max(1, Math.min(IMAGE_TIMEOUT_MS, deadline - Date.now()));
    request.setTimeout(remaining, () => request.destroy(new Error("Image request timed out")));
    request.on("error", reject);
  });
}

function proxyImage(imageUrl, _req, res) {
  if (!imageUrl) {
    sendPlaceholderImage(res);
    return;
  }

  fetchTrustedImage(imageUrl, 0, Date.now() + IMAGE_TOTAL_TIMEOUT_MS)
    .then(({ contentType, body }) => {
      if (res.headersSent) return;
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": body.length,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(body);
    })
    .catch(() => sendPlaceholderImage(res));
}

function sendPlaceholderImage(res) {
  if (res.headersSent) return;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#6ea8ff"/>
        <stop offset="100%" style="stop-color:#7267ff"/>
      </linearGradient>
    </defs>
    <rect width="300" height="300" fill="url(#g)" rx="20"/>
    <text x="150" y="145" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-size="48" font-family="sans-serif">🎵</text>
    <text x="150" y="195" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="16" font-family="sans-serif">网易云音乐</text>
  </svg>`;

  res.writeHead(200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(svg);
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

module.exports = { searchSongs, getSongUrl, proxyAudio, proxyImage };
