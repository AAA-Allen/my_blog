(function () {
  var appRoot = document.getElementById("app");
  var audio = document.getElementById("audioPlayer");
  var backgroundAudio = document.getElementById("backgroundAudio");
  var backgroundVideo = document.querySelector(".video-background video");

  if (!appRoot) {
    return;
  }

  if (!audio) {
    audio = document.createElement("audio");
    audio.id = "audioPlayer";
    audio.preload = "metadata";
    document.body.appendChild(audio);
  }

  if (!backgroundAudio) {
    backgroundAudio = document.createElement("audio");
    backgroundAudio.id = "backgroundAudio";
    backgroundAudio.preload = "metadata";
    backgroundAudio.loop = true;
    backgroundAudio.src = "/videos/wallpaper.mp4";
    backgroundAudio.hidden = true;
    document.body.appendChild(backgroundAudio);
  }

  var weekNames = ["日", "一", "二", "三", "四", "五", "六"];
  var routeTitleMap = {
    home: "首页",
    archive: "归档",
    categories: "分类",
    tags: "标签",
    timeline: "时光机",
    about: "关于我",
    photos: "照片墙",
    community: "社区广场",
    admin: "后台统计",
    article: "文章详情",
    notFound: "页面未找到",
  };

  var state = {
    siteBundle: null,
    tracks: [],
    activeTrackIndex: 0,
    playlistOpen: true,
    playMode: "repeat-all",
    photoItems: [],
    activePhotoIndex: 0,
    unavailableTrackIds: new Set(),
    playerStatus: "",
    playerStatusTone: "",
    playerWantsPlayback: false,
    previousPlayerVolume: 0.75,
    latestArticles: [],
    adminCollections: {
      articles: [],
      playlist: [],
      media: [],
    },
    adminAuthenticated: false,
    adminSessionChecked: false,
    adminSessionMessage: "",
    adminReauthPending: false,
    backgroundAudioEnabled: readStoredBool("blog-background-audio"),
    playerSyncTimer: null,
    lastPlayerAutoSyncSecond: -1,
    calendarState: {
      year: new Date().getFullYear(),
      month: new Date().getMonth(),
    },
    route: parseLocation(true),
  };

  var playerRefs = {};
  var calendarRefs = {};
  var backgroundRefs = {};
  var playerEventsBound = false;
  var backgroundEventsBound = false;
  var adminArticleAutosaveTimer = null;
  var adminArticlePreviewTimer = null;
  var playerRemoteSaveTimer = null;
  var playerSkipTimer = null;
  var playerNoticeTimer = null;
  var cleanupReadingProgress = null;

  function readStoredBool(key) {
    try {
      return window.localStorage.getItem(key) === "true";
    } catch (_error) {
      return false;
    }
  }

  function writeStoredBool(key, value) {
    try {
      window.localStorage.setItem(key, String(Boolean(value)));
    } catch (_error) {
      return;
    }
  }

  function readStoredJson(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_error) {
      return null;
    }
  }

  function writeStoredJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_error) {
      return;
    }
  }

  function removeStoredValue(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      return;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function readApiBody(response) {
    if (response.status === 204) {
      return Promise.resolve({});
    }

    return response.text().then(function (text) {
      if (!text) return {};

      try {
        return JSON.parse(text);
      } catch (_error) {
        return { message: text };
      }
    });
  }

  function triggerAdminReauthentication(url) {
    if (
      state.route.pageType !== "admin" ||
      url === "/api/admin/session" ||
      state.adminReauthPending
    ) {
      return;
    }

    state.adminAuthenticated = false;
    state.adminSessionChecked = true;
    state.adminSessionMessage = "登录状态已失效，请重新登录。";
    state.adminReauthPending = true;

    setTimeout(function () {
      state.adminReauthPending = false;
      if (state.route.pageType === "admin") {
        renderCurrentRoute();
      }
    }, 0);
  }

  function createApiError(response, body, url) {
    var error = new Error(body && body.message ? body.message : "Request failed: " + response.status);
    error.status = response.status;

    if (response.status === 401) {
      triggerAdminReauthentication(url);
    }

    return error;
  }

  function apiFetch(url) {
    return fetch(url).then(function (response) {
      return readApiBody(response).then(function (body) {
        if (!response.ok) {
          throw createApiError(response, body, url);
        }

        return body;
      });
    });
  }

  function apiSend(url, method, payload) {
    return fetch(url, {
      method: method,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
    }).then(function (response) {
      return readApiBody(response).then(function (body) {
        if (!response.ok) {
          throw createApiError(response, body, url);
        }

        return body;
      });
    });
  }

  function apiUpload(url, formData) {
    return fetch(url, {
      method: "POST",
      body: formData,
    }).then(function (response) {
      return readApiBody(response).then(function (body) {
        if (!response.ok) {
          throw createApiError(response, body, url);
        }
        return body;
      });
    });
  }

  function parseLocation(respectServerState) {
    var pathname = window.location.pathname;
    var params = new URLSearchParams(window.location.search);
    var route = {
      path: pathname,
      pageType: pathname === "/" ? "home" : "notFound",
      articleSlug: null,
      communityPage: Math.max(1, Number(params.get("page")) || 1),
      articlePage: Math.max(1, Number(params.get("page")) || 1),
      filters: {
        date: params.get("date") || "",
        category: params.get("category") || "",
        tag: params.get("tag") || "",
        search: params.get("search") || "",
      },
    };

    if (respectServerState && window.__BLOG_STATE__ && window.__BLOG_STATE__.pageType === "notFound") {
      return route;
    }

    if (pathname === "/archive") {
      route.pageType = "archive";
    } else if (pathname === "/categories") {
      route.pageType = "categories";
    } else if (pathname === "/tags") {
      route.pageType = "tags";
    } else if (pathname === "/timeline") {
      route.pageType = "timeline";
    } else if (pathname === "/about") {
      route.pageType = "about";
    } else if (pathname === "/photos") {
      route.pageType = "photos";
    } else if (pathname === "/community") {
      route.pageType = "community";
    } else if (pathname === "/admin") {
      route.pageType = "admin";
    } else if (pathname.indexOf("/articles/") === 0) {
      route.pageType = "article";
      route.articleSlug = decodeURIComponent(pathname.replace("/articles/", ""));
    }

    return route;
  }

  function applyRouteCalendarState(route) {
    if (!route || !route.filters || !route.filters.date) {
      return;
    }

    var selected = new Date(route.filters.date);
    if (!Number.isNaN(selected.getTime())) {
      state.calendarState.year = selected.getFullYear();
      state.calendarState.month = selected.getMonth();
    }
  }

  function createCover(label, colorA, colorB) {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">' +
      "<defs>" +
      '<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">' +
      '<stop offset="0%" stop-color="' +
      colorA +
      '"/>' +
      '<stop offset="100%" stop-color="' +
      colorB +
      '"/>' +
      "</linearGradient>" +
      "</defs>" +
      '<rect width="240" height="240" rx="28" fill="url(#bg)"/>' +
      '<circle cx="120" cy="120" r="78" fill="rgba(255,255,255,0.16)"/>' +
      '<circle cx="120" cy="120" r="48" fill="rgba(7,12,24,0.35)"/>' +
      '<circle cx="120" cy="120" r="6" fill="rgba(255,255,255,0.88)"/>' +
      '<text x="50%" y="56%" text-anchor="middle" font-size="28" font-family="Arial" fill="white">' +
      label +
      "</text>" +
      "</svg>";

    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function createMelodyTrack(notes, options) {
    var sampleRate = 22050;
    var secondsPerBeat = 60 / options.bpm;
    var volume = options.volume || 0.38;
    var samples = [];

    notes.forEach(function (note) {
      var duration = note.beats * secondsPerBeat;
      var totalSamples = Math.max(1, Math.floor(duration * sampleRate));
      var fadeSamples = Math.max(1, Math.floor(totalSamples * 0.12));

      for (var i = 0; i < totalSamples; i += 1) {
        var time = i / sampleRate;
        var fadeIn = Math.min(1, i / fadeSamples);
        var fadeOut = Math.min(1, (totalSamples - i) / fadeSamples);
        var envelope = fadeIn * fadeOut;
        var sample = 0;

        if (note.frequency > 0) {
          sample =
            Math.sin(2 * Math.PI * note.frequency * time) * 0.7 +
            Math.sin(2 * Math.PI * note.frequency * 2 * time) * 0.2 +
            Math.sin(2 * Math.PI * note.frequency * 0.5 * time) * 0.1;
        }

        samples.push(sample * envelope * volume);
      }
    });

    var pcmData = new Int16Array(samples.length);
    for (var j = 0; j < samples.length; j += 1) {
      pcmData[j] = Math.max(-1, Math.min(1, samples[j])) * 32767;
    }

    var buffer = new ArrayBuffer(44 + pcmData.length * 2);
    var view = new DataView(buffer);

    function writeString(offset, value) {
      for (var k = 0; k < value.length; k += 1) {
        view.setUint8(offset + k, value.charCodeAt(k));
      }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + pcmData.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, pcmData.length * 2, true);

    for (var n = 0; n < pcmData.length; n += 1) {
      view.setInt16(44 + n * 2, pcmData[n], true);
    }

    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  }

  function normalizeTracks(items) {
    return (items || []).map(function (item) {
      var coverValue = item.coverUrl
        ? item.coverUrl
        : item.cover && item.cover.label
          ? createCover(item.cover.label, item.cover.from, item.cover.to)
          : "";
      var srcValue = item.audioUrl
        ? item.audioUrl
        : Array.isArray(item.notes) && item.notes.length
          ? createMelodyTrack(item.notes, { bpm: item.bpm })
          : "";
      var sourceType = String(item.audioUrl || "").indexOf("/api/netease/audio/") === 0
        ? "netease"
        : item.audioUrl
          ? "external"
          : "synthesized";

      return {
        id: item.id,
        title: item.title,
        artist: item.artist,
        subtitle: item.subtitle || item.artist || "",
        cover: coverValue,
        src: srcValue,
        sourceType: sourceType,
      };
    });
  }

  function formatTime(value) {
    if (!Number.isFinite(value)) return "00:00";
    var minute = Math.floor(value / 60);
    var second = Math.floor(value % 60);
    return String(minute).padStart(2, "0") + ":" + String(second).padStart(2, "0");
  }

  function formatDateLabel(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;

    return (
      date.getFullYear() +
      "-" +
      String(date.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(date.getDate()).padStart(2, "0")
    );
  }

  function formatDateTimeLabel(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;

    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function formatRelativeTime(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    var diff = Date.now() - date.getTime();
    var minute = 60 * 1000;
    var hour = 60 * minute;
    var day = 24 * hour;

    if (diff < hour) {
      return Math.max(1, Math.round(diff / minute)) + " 分钟前";
    }

    if (diff < day) {
      return Math.max(1, Math.round(diff / hour)) + " 小时前";
    }

    if (diff < day * 7) {
      return Math.max(1, Math.round(diff / day)) + " 天前";
    }

    return formatDateTimeLabel(iso);
  }

  function getAnalyticsProviderLabel(provider) {
    if (provider === "google-analytics") return "Google Analytics";
    if (provider === "umami") return "Umami";
    if (provider === "clarity") return "Microsoft Clarity";
    return "Plausible";
  }

  function serializeDataAttributes(attributes) {
    return Object.keys(attributes)
      .map(function (key) {
        return ' data-' + key + '="' + escapeHtml(attributes[key]) + '"';
      })
      .join("");
  }

  function renderLikeButton(options) {
    return (
      '<button type="button" class="comment-action' +
      (options.liked ? " is-liked" : "") +
      '"' +
      serializeDataAttributes(options.attributes) +
      ' aria-pressed="' +
      (options.liked ? "true" : "false") +
      '">' +
      '<i class="fa-' +
      (options.liked ? "solid" : "regular") +
      ' fa-heart"></i><span>' +
      Number(options.count || 0) +
      "</span>" +
      (options.label ? "<em>" + escapeHtml(options.label) + "</em>" : "") +
      "</button>"
    );
  }

  function createIdentityFields() {
    return (
      '<div class="comment-form__identity">' +
      '<label class="form-field"><span class="form-field__label">昵称</span>' +
      '<input type="text" name="name" maxlength="24" placeholder="你的昵称" autocomplete="nickname" /></label>' +
      '<label class="form-field"><span class="form-field__label">头像链接（可选）</span>' +
      '<input type="url" name="avatar" maxlength="300" placeholder="https://example.com/avatar.jpg" inputmode="url" /></label>' +
      "</div>"
    );
  }

  function renderFormStatus() {
    return '<p class="form-status" data-form-status role="status" aria-live="polite"></p>';
  }

  function setFormStatus(form, message, tone) {
    var status = form && form.querySelector("[data-form-status]");
    if (!status) return;

    status.textContent = message || "";
    status.classList.toggle("is-error", tone === "error");
    status.classList.toggle("is-success", tone === "success");
  }

  function serializeFilters(filters) {
    var params = new URLSearchParams();

    Object.keys(filters).forEach(function (key) {
      if (filters[key]) {
        params.set(key, filters[key]);
      }
    });

    var query = params.toString();
    return query ? "?" + query : "";
  }

  function setDocumentTitle(title) {
    document.title = title ? title + " | 朝花夕拾" : "朝花夕拾";
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getActiveSearchTerm() {
    return state.route && state.route.filters ? String(state.route.filters.search || "").trim() : "";
  }

  function highlightSearchTerm(value) {
    var text = String(value || "");
    var term = getActiveSearchTerm();
    if (!term) {
      return escapeHtml(text);
    }

    return text
      .split(new RegExp("(" + escapeRegExp(term) + ")", "gi"))
      .map(function (part, index) {
        return index % 2 ? '<mark class="search-hit">' + escapeHtml(part) + "</mark>" : escapeHtml(part);
      })
      .join("");
  }

  function stripHtmlClient(value) {
    return String(value || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function estimateReadingMinutes(article) {
    var text = stripHtmlClient((article && article.content) || "") + " " + ((article && article.excerpt) || "");
    var cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    var words = (text.replace(/[\u4e00-\u9fff]/g, " ").match(/[A-Za-z0-9_]+/g) || []).length;
    return Math.max(1, Math.ceil((cjk + words) / 450));
  }

  function slugifyHeading(value, index) {
    var slug = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "section-" + index;
  }

  function enhanceArticleContent(content) {
    var toc = [];
    var enhanced = String(content || "").replace(/<h([2-3])([^>]*)>([\s\S]*?)<\/h\1>/gi, function (match, level, attributes, inner) {
      var title = stripHtmlClient(inner);
      var idMatch = String(attributes || "").match(/\sid=["']([^"']+)["']/i);
      var id = idMatch ? idMatch[1] : slugifyHeading(title, toc.length + 1);
      toc.push({ id: id, level: Number(level), title: title });

      if (idMatch) {
        return match;
      }

      return "<h" + level + attributes + ' id="' + escapeHtml(id) + '">' + inner + "</h" + level + ">";
    });

    enhanced = enhanced
      .replace(/<pre([^>]*)>/gi, '<div class="code-block"><button type="button" class="code-copy" data-action="copy-code">复制</button><pre$1>')
      .replace(/<\/pre>/gi, "</pre></div>");

    return { content: enhanced, toc: toc };
  }

  function renderArticleToc(toc) {
    if (!toc.length) {
      return "";
    }

    return (
      '<nav class="article-toc" aria-label="文章目录"><strong>目录</strong>' +
      toc
        .map(function (item) {
          return (
            '<a class="article-toc__item article-toc__item--h' +
            item.level +
            '" href="#' +
            encodeURIComponent(item.id) +
            '">' +
            escapeHtml(item.title) +
            "</a>"
          );
        })
        .join("") +
      "</nav>"
    );
  }

  function renderArticleShare(article) {
    var url = window.location.origin + "/articles/" + encodeURIComponent(article.slug);
    return (
      '<div class="article-share" aria-label="分享文章">' +
      '<button type="button" class="button-secondary" data-action="share-article" data-url="' +
      escapeHtml(url) +
      '" data-title="' +
      escapeHtml(article.title) +
      '"><i class="fa-solid fa-share-nodes"></i> 分享</button>' +
      '<a class="button-secondary" target="_blank" rel="noreferrer" href="https://twitter.com/intent/tweet?url=' +
      encodeURIComponent(url) +
      "&text=" +
      encodeURIComponent(article.title) +
      '"><i class="fa-brands fa-x-twitter"></i> X</a>' +
      "</div>"
    );
  }

  function renderArticleNav(nav) {
    if (!nav || (!nav.prev && !nav.next)) {
      return "";
    }

    function link(item, label) {
      if (!item) {
        return '<span class="article-nav__item is-disabled">' + label + "</span>";
      }

      return (
        '<a class="article-nav__item" href="/articles/' +
        encodeURIComponent(item.slug) +
        '"><span>' +
        label +
        "</span><strong>" +
        escapeHtml(item.title) +
        "</strong></a>"
      );
    }

    return '<nav class="article-nav">' + link(nav.prev, "上一篇") + link(nav.next, "下一篇") + "</nav>";
  }

  function renderVideoCard(className) {
    return (
      '<div class="media-card ' +
      className +
      '">' +
      '<video autoplay muted loop playsinline>' +
      '<source src="/videos/wallpaper.mp4" type="video/mp4" />' +
      "</video>" +
      '<div class="media-card__shine"></div>' +
      "</div>"
    );
  }

  function renderArticleCover(article, className) {
    var cover = article && article.cover;
    if (!cover || !cover.url) {
      return (
        '<div class="media-card article-cover article-cover--placeholder ' +
        className +
        '"><i class="fa-regular fa-image"></i><span>暂无封面</span></div>'
      );
    }

    return (
      '<picture class="media-card article-cover ' +
      className +
      '"><source type="image/webp" srcset="' +
      escapeHtml(cover.thumbnailUrl || cover.url) +
      " 480w, " +
      escapeHtml(cover.mediumUrl || cover.url) +
      " 960w, " +
      escapeHtml(cover.largeUrl || cover.url) +
      ' 1600w" sizes="(max-width: 760px) 100vw, 420px" />' +
      '<img src="' +
      escapeHtml(cover.mediumUrl || cover.url) +
      '" alt="' +
      escapeHtml(cover.alt || article.title) +
      '" loading="lazy" decoding="async" /></picture>'
    );
  }

  function renderPostItem(article) {
    var readingMinutes = estimateReadingMinutes(article);

    return (
      '<article class="post-item">' +
      '<div class="post-item__content">' +
      "<h3>" +
      highlightSearchTerm(article.title) +
      "</h3>" +
      '<div class="article-meta">' +
      "<span><i class=\"fa-regular fa-user\"></i> " + escapeHtml(state.siteBundle.profile.name || "站长") + "</span>" +
      "<span><i class=\"fa-regular fa-calendar\"></i> " +
      escapeHtml(article.date.display || formatDateLabel(article.date.iso)) +
      "</span>" +
      "<span><i class=\"fa-regular fa-folder-open\"></i> " +
      escapeHtml(article.category) +
      "</span>" +
      "<span><i class=\"fa-regular fa-clock\"></i> " +
      readingMinutes +
      " min read</span>" +
      "</div>" +
      "<p>" +
      highlightSearchTerm(article.searchSnippet || article.excerpt) +
      "</p>" +
      '<a class="article-link" href="/articles/' +
      encodeURIComponent(article.slug) +
      '">阅读全文</a>' +
      "</div>" +
      renderArticleCover(article, "post-thumb") +
      "</article>"
    );
  }

  function renderPlayerCard() {
    if (state.route.pageType !== "home") {
      return "";
    }

    return (
      '<section class="glass-panel player-card" id="playerCard">' +
      '<div class="player-disc">' +
      '<div class="player-disc__record"></div>' +
      '<div class="player-disc__cover-wrap"><img id="coverImage" alt="当前歌曲封面" /></div>' +
      "</div>" +
      '<div class="player-main">' +
      '<div class="player-head">' +
      "<div>" +
      '<h3 id="songTitle">Lemon</h3>' +
      '<p id="songArtist">Prototype Mix</p>' +
      "</div>" +
      '<button type="button" class="playlist-toggle" id="playlistToggle" aria-label="切换播放列表">' +
      '<i class="fa-solid fa-list"></i>' +
      "</button>" +
      "</div>" +
      '<div class="player-lyrics" id="songSubtitle" role="status" aria-live="polite">未闻花名的晚风，吹向银河彼岸。</div>' +
      '<div class="player-progress">' +
      '<span id="currentTime">00:00</span>' +
      '<input id="progressRange" type="range" min="0" max="100" value="0" />' +
      '<span id="durationTime">00:00</span>' +
      "</div>" +
      '<div class="player-controls">' +
      '<button type="button" id="playModeButton" class="play-mode-button" aria-label="切换播放模式" title="列表循环"><i class="fa-solid fa-repeat"></i></button>' +
      '<button type="button" id="prevButton" aria-label="上一曲"><i class="fa-solid fa-backward-step"></i></button>' +
      '<button type="button" id="playButton" class="play-button" aria-label="播放或暂停"><i class="fa-solid fa-play"></i></button>' +
      '<button type="button" id="nextButton" aria-label="下一曲"><i class="fa-solid fa-forward-step"></i></button>' +
      '<div class="volume-box" aria-label="音量控制">' +
      '<button type="button" class="volume-mute" id="muteButton" aria-label="静音"><i class="fa-solid fa-volume-high"></i></button>' +
      '<input id="volumeRange" type="range" min="0" max="100" value="75" aria-label="音量" />' +
      "</div>" +
      "</div>" +
      "</div>" +
      '<aside class="player-playlist" id="playlistPanel">' +
      '<div class="player-playlist__title"><span>播放列表</span><small id="playlistSummary"></small></div>' +
      '<ul id="playlistItems"></ul>' +
      "</aside>" +
      "</section>"
    );
  }

  function renderMiniPlayer() {
    return (
      '<section class="mini-player" id="miniPlayer">' +
      '<button type="button" class="mini-player__button mini-player__mode" id="miniPlayModeButton" aria-label="切换播放模式" title="列表循环"><i class="fa-solid fa-repeat"></i></button>' +
      '<button type="button" class="mini-player__button" id="miniPrevButton" aria-label="上一曲"><i class="fa-solid fa-backward-step"></i></button>' +
      '<button type="button" class="mini-player__button mini-player__button--play" id="miniPlayButton" aria-label="播放或暂停"><i class="fa-solid fa-play"></i></button>' +
      '<button type="button" class="mini-player__button" id="miniNextButton" aria-label="下一曲"><i class="fa-solid fa-forward-step"></i></button>' +
      '<img class="mini-player__cover" id="miniCoverImage" alt="当前歌曲封面" />' +
      '<div class="mini-player__meta"><strong id="miniTrackTitle">未播放</strong><span id="miniTrackArtist">点击开始播放</span></div>' +
      "</section>"
    );
  }

  function renderSiteInfo(stats) {
    return (
      '<section class="glass-panel stat-panel">' +
      '<div class="panel-title"><i class="fa-solid fa-chart-column"></i><span>网站信息</span></div>' +
      '<div class="site-stat-list">' +
      "<div><span>今日浏览量</span><strong>" +
      stats.todayViewCount +
      "</strong></div>" +
      "<div><span>今日访客数</span><strong>" +
      stats.todayVisitorCount +
      "</strong></div>" +
      "<div><span>本站总浏览量</span><strong>" +
      stats.viewCount +
      "</strong></div>" +
      "<div><span>本站访客数</span><strong>" +
      stats.visitorCount +
      "</strong></div>" +
      "</div>" +
      "</section>"
    );
  }

  function renderAdminArticleItems(items) {
    if (!items.length) {
      return '<div class="empty-state empty-state--compact">还没有文章，先在左侧表单里创建第一篇文章吧。</div>';
    }

    return items
      .map(function (article) {
        var scheduledTime = article.publishAt ? new Date(article.publishAt).getTime() : 0;
        var isVisible = article.status !== "draft" && (article.status !== "scheduled" || scheduledTime <= Date.now());
        var statusLabel = article.status === "draft" ? "草稿" : article.status === "scheduled" && !isVisible ? "定时" : "已发布";
        return (
          '<article class="admin-record admin-record--article">' +
          '<div class="admin-record__main">' +
          "<strong>" +
          escapeHtml(article.title) +
          "</strong>" +
          '<div class="admin-record__meta">' +
          '<span class="admin-tag admin-tag--status admin-tag--' +
          escapeHtml(article.status || "published") +
          '">' +
          statusLabel +
          "</span>" +
          "<span>" +
          escapeHtml(article.date && article.date.display ? article.date.display : "") +
          "</span>" +
          "<span>" +
          escapeHtml(article.category || "未分类") +
          "</span>" +
          "<span>" +
          Number(article.likes || 0) +
          " 赞</span>" +
          "</div>" +
          '<p class="admin-record__desc">' +
          escapeHtml(article.excerpt || "暂无摘要。") +
          "</p>" +
          "</div>" +
          '<div class="admin-record__actions">' +
          (isVisible
            ? '<a class="button-secondary" href="/articles/' + encodeURIComponent(article.slug) + '">查看</a>'
            : "") +
          '<button type="button" class="button-secondary" data-action="edit-admin-article" data-slug="' +
          escapeHtml(article.slug) +
          '">编辑</button>' +
          '<button type="button" class="button-secondary" data-action="versions-admin-article" data-slug="' +
          escapeHtml(article.slug) +
          '">版本</button>' +
          '<button type="button" class="comment-action comment-action--danger" data-action="delete-admin-article" data-slug="' +
          escapeHtml(article.slug) +
          '"><i class="fa-regular fa-trash-can"></i><em>删除</em></button>' +
          "</div>" +
          "</article>"
        );
      })
      .join("");
  }

  function renderAdminTrackItems(items) {
    if (!items.length) {
      return '<div class="empty-state empty-state--compact">还没有音乐，新增后首页播放器就会直接读取到新的歌单。</div>';
    }

    return items
      .map(function (track) {
        var coverHtml = track.coverUrl
          ? '<img class="admin-record__cover" src="' + escapeHtml(track.coverUrl) + '" alt="" loading="lazy" />'
          : "";
        var sourceTag = track.coverUrl && track.audioUrl && track.audioUrl.indexOf("/api/netease/") === 0
          ? '<span class="admin-tag admin-tag--netease">网易云</span>'
          : track.audioUrl
            ? '<span class="admin-tag">外链</span>'
            : '<span class="admin-tag">合成</span>';

        return (
          '<article class="admin-record">' +
          coverHtml +
          '<div class="admin-record__main">' +
          "<strong>" +
          escapeHtml(track.title) +
          "</strong>" +
          '<div class="admin-record__meta">' +
          "<span>" +
          escapeHtml(track.artist || "Unknown Artist") +
          "</span>" +
          sourceTag +
          "<span>BPM " +
          Number(track.bpm || 96) +
          "</span>" +
          "</div>" +
          '<p class="admin-record__desc">' +
          escapeHtml(track.subtitle || "暂无副标题。") +
          "</p>" +
          "</div>" +
          '<div class="admin-record__actions">' +
          '<button type="button" class="button-secondary" data-action="edit-admin-track" data-id="' +
          escapeHtml(track.id) +
          '">编辑</button>' +
          '<button type="button" class="comment-action comment-action--danger" data-action="delete-admin-track" data-id="' +
          escapeHtml(track.id) +
          '"><i class="fa-regular fa-trash-can"></i><em>删除</em></button>' +
          "</div>" +
          "</article>"
        );
      })
      .join("");
  }

  function renderAdminMediaItems(items) {
    if (!items.length) {
      return '<div class="empty-state empty-state--compact">媒体库还是空的，上传第一张照片后即可设置文章封面或加入照片墙。</div>';
    }

    return items
      .map(function (asset) {
        return (
          '<article class="admin-media-card" data-media-id="' + escapeHtml(asset.id) + '">' +
          '<img src="' + escapeHtml(asset.thumbnailUrl || asset.url) + '" alt="' + escapeHtml(asset.alt || asset.title) + '" loading="lazy" />' +
          '<div class="admin-media-card__fields"><input type="text" data-media-field="title" maxlength="120" value="' + escapeHtml(asset.title || "") + '" placeholder="图片标题" />' +
          '<input type="text" data-media-field="alt" maxlength="160" value="' + escapeHtml(asset.alt || "") + '" placeholder="替代文字" />' +
          '<textarea data-media-field="caption" rows="2" maxlength="500" placeholder="图片说明">' + escapeHtml(asset.caption || "") + "</textarea>" +
          '<div class="admin-form-grid admin-form-grid--two"><input type="datetime-local" data-media-field="takenAt" value="' + toDateTimeLocalValue(asset.takenAt) + '" />' +
          '<select data-media-field="status"><option value="published"' + (asset.status !== "hidden" ? " selected" : "") + '>公开</option><option value="hidden"' + (asset.status === "hidden" ? " selected" : "") + ">隐藏</option></select></div>" +
          '<label class="admin-check"><input type="checkbox" data-media-field="isPhoto"' + (asset.isPhoto ? " checked" : "") + ' /> 加入照片墙</label>' +
          '<div class="admin-record__meta"><span>' + Number(asset.width || 0) + " × " + Number(asset.height || 0) + "</span><span>引用 " + Number(asset.usage && asset.usage.total || 0) + " 次</span></div>" +
          '<div class="admin-record__actions"><button type="button" class="button-secondary" data-action="save-admin-media">保存</button>' +
          '<button type="button" class="comment-action comment-action--danger" data-action="delete-admin-media"><i class="fa-regular fa-trash-can"></i><em>删除</em></button></div></div></article>'
        );
      })
      .join("");
  }

  function renderAdminLoginMain() {
    return (
      '<main class="admin-login-main">' +
      '<section class="glass-panel admin-login-card" aria-labelledby="adminLoginTitle">' +
      '<div class="admin-login-card__icon" aria-hidden="true"><i class="fa-solid fa-lock"></i></div>' +
      '<div><p class="eyebrow">Private Console</p><h1 id="adminLoginTitle">站长登录</h1>' +
      '<p class="admin-login-card__copy">请输入站长密码后继续管理文章、音乐与访问统计。</p></div>' +
      '<form class="admin-login-form" data-form="admin-login">' +
      '<label class="form-field" for="adminPassword"><span class="form-field__label">站长密码</span></label>' +
      '<input id="adminPassword" name="password" type="password" autocomplete="current-password" required aria-describedby="adminLoginStatus" />' +
      '<p id="adminLoginStatus" class="form-status" data-form-status role="status" aria-live="polite">' +
      escapeHtml(state.adminSessionMessage) +
      '</p><button type="submit" class="button-primary">登录后台</button>' +
      "</form>" +
      '<a class="admin-login-card__back" href="/"><i class="fa-solid fa-arrow-left"></i> 返回博客首页</a>' +
      "</section>" +
      "</main>"
    );
  }

  function renderAdminMain(pageData) {
    var admin = pageData.admin;
    var adminArticles = pageData.adminCollections && Array.isArray(pageData.adminCollections.articles) ? pageData.adminCollections.articles : [];
    var adminPlaylist = pageData.adminCollections && Array.isArray(pageData.adminCollections.playlist) ? pageData.adminCollections.playlist : [];
    var adminMedia = pageData.adminCollections && Array.isArray(pageData.adminCollections.media) ? pageData.adminCollections.media : [];
    var socialMap = {};
    (state.siteBundle.profile.socials || []).forEach(function (social) { socialMap[social.label] = social.url; });
    var sourceItems = admin.sources.length
      ? admin.sources
          .map(function (item) {
            return (
              '<div class="admin-source-row"><span>' +
              escapeHtml(item.name) +
              '</span><strong>' +
              item.count +
              "</strong></div>"
            );
          })
          .join("")
      : '<div class="empty-state empty-state--compact">暂时还没有来源统计数据。</div>';
    var dailyItems = admin.daily.length
      ? admin.daily
          .map(function (item) {
            return (
              "<tr><td>" +
              escapeHtml(item.date) +
              "</td><td>" +
              item.pageViews +
              "</td><td>" +
              item.uniqueVisitors +
              "</td></tr>"
            );
          })
          .join("")
      : '<tr><td colspan="3">暂无每日统计数据。</td></tr>';

    return (
      '<main class="main-column admin-dashboard">' +
      '<section class="glass-panel page-panel admin-panel">' +
      '<div class="page-heading"><div><h2>后台统计面板</h2><p>查看来源、今日访问情况，以及第三方统计服务接入状态。</p></div>' +
      '<button type="button" class="button-secondary" data-action="admin-logout"><i class="fa-solid fa-right-from-bracket"></i> 退出后台</button></div>' +
      '<div class="admin-grid">' +
      '<article class="admin-stat-card"><span>总浏览量</span><strong>' +
      admin.overview.totalViews +
      "</strong></article>" +
      '<article class="admin-stat-card"><span>总访客数</span><strong>' +
      admin.overview.totalVisitors +
      "</strong></article>" +
      '<article class="admin-stat-card"><span>今日浏览量</span><strong>' +
      admin.overview.todayViews +
      "</strong></article>" +
      '<article class="admin-stat-card"><span>今日访客数</span><strong>' +
      admin.overview.todayVisitors +
      "</strong></article>" +
      '<article class="admin-stat-card"><span>累计点赞</span><strong>' +
      admin.overview.totalLikes +
      "</strong></article>" +
      '<article class="admin-stat-card"><span>累计评论</span><strong>' +
      admin.overview.totalComments +
      "</strong></article>" +
      "</div>" +
      '<div class="admin-grid admin-grid--two">' +
      '<section class="admin-section"><div class="panel-title"><i class="fa-solid fa-share-nodes"></i><span>访客来源统计</span></div>' +
      sourceItems +
      "</section>" +
      '<section class="admin-section"><div class="panel-title"><i class="fa-solid fa-signal"></i><span>第三方统计服务</span></div>' +
      '<div class="admin-third-party">' +
      '<div><span>当前服务</span><strong>' +
      escapeHtml(getAnalyticsProviderLabel(admin.thirdParty.provider)) +
      "</strong></div>" +
      '<div><span>启用状态</span><strong class="admin-pill' +
      (admin.thirdParty.enabled ? " is-on" : "") +
      '">' +
      (admin.thirdParty.enabled ? "已启用" : "未启用") +
      "</strong></div>" +
      '<div><span>配置状态</span><strong class="admin-pill' +
      (admin.thirdParty.configured ? " is-on" : "") +
      '">' +
      (admin.thirdParty.configured ? "已完成" : "待填写凭据") +
      "</strong></div>" +
      '<p class="admin-note">如需真正接入专业第三方统计，只要在 `site-data.json` 的 `analytics.thirdParty` 中填写对应域名或 ID 即可生效。</p>' +
      "</div></section>" +
      "</div>" +
      '<section class="admin-section"><div class="panel-title"><i class="fa-solid fa-calendar-days"></i><span>近 7 日趋势</span></div>' +
      '<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>日期</th><th>浏览量</th><th>访客数</th></tr></thead><tbody>' +
      dailyItems +
      "</tbody></table></div>" +
      '<div class="admin-note">最近访问时间：' +
      escapeHtml(admin.overview.lastVisitLabel) +
      "</div></section>" +
      '<section class="admin-section admin-manager-section"><div class="panel-title"><i class="fa-solid fa-sliders"></i><span>网站资料设置</span></div>' +
      '<form class="comment-form admin-form" data-form="admin-settings"><div class="admin-form-grid admin-form-grid--two">' +
      '<input type="text" name="title" maxlength="80" value="' + escapeHtml(state.siteBundle.site.title || "") + '" placeholder="网站标题" required />' +
      '<input type="text" name="name" maxlength="80" value="' + escapeHtml(state.siteBundle.profile.name || "") + '" placeholder="站长名称" required /></div>' +
      '<input type="text" name="tagline" maxlength="180" value="' + escapeHtml(state.siteBundle.site.tagline || "") + '" placeholder="网站简介" />' +
      '<textarea name="announcement" rows="3" maxlength="500" placeholder="网站公告">' + escapeHtml(state.siteBundle.site.announcement || "") + "</textarea>" +
      '<div class="admin-form-grid admin-form-grid--two"><input type="text" name="bio" maxlength="240" value="' + escapeHtml(state.siteBundle.profile.bio || "") + '" placeholder="个人简介" />' +
      '<input type="text" name="avatar" maxlength="500" value="' + escapeHtml(state.siteBundle.profile.avatar || "") + '" placeholder="头像地址" /></div>' +
      '<textarea name="about" rows="5" maxlength="3000" placeholder="关于我">' + escapeHtml(state.siteBundle.profile.about || "") + "</textarea>" +
      '<input type="text" name="copyright" maxlength="180" value="' + escapeHtml(state.siteBundle.site.copyright || "") + '" placeholder="版权文字" />' +
      '<div class="admin-form-grid admin-form-grid--three"><input type="url" name="github" maxlength="500" value="' + escapeHtml(socialMap.GitHub || "") + '" placeholder="GitHub 个人主页；留空隐藏" />' +
      '<input type="url" name="weibo" maxlength="500" value="' + escapeHtml(socialMap.Weibo || "") + '" placeholder="微博个人主页；留空隐藏" />' +
      '<input type="url" name="douyin" maxlength="500" value="' + escapeHtml(socialMap.TikTok || "") + '" placeholder="抖音个人主页；留空隐藏" /></div>' +
      renderFormStatus() + '<div class="comment-form__footer"><span>留空的社交平台不会在前台显示。</span><button type="submit" class="button-primary">保存网站资料</button></div></form></section>' +
      '<section class="admin-section admin-manager-section">' +
      '<div class="panel-title"><i class="fa-solid fa-newspaper"></i><span>文章管理</span></div>' +
      '<div class="admin-manager-grid">' +
      '<section class="admin-editor">' +
      '<div class="admin-editor__header"><h3 id="adminArticleFormTitle">新建文章</h3><button type="button" class="button-secondary" data-action="reset-admin-article">清空</button></div>' +
      '<form class="comment-form admin-form" id="adminArticleForm" data-form="admin-article">' +
      '<input type="hidden" name="currentSlug" value="" />' +
      '<div class="admin-form-grid admin-form-grid--two">' +
      '<input type="text" name="title" maxlength="120" placeholder="文章标题" required />' +
      '<input type="text" name="slug" maxlength="120" placeholder="文章 slug，例如 hello-world" />' +
      "</div>" +
      '<div class="admin-form-grid admin-form-grid--three">' +
      '<input type="date" name="date" />' +
      '<input type="text" name="category" maxlength="40" placeholder="分类" />' +
      '<input type="text" name="tags" maxlength="120" placeholder="标签，多个用逗号分隔" />' +
      "</div>" +
      '<div class="admin-form-grid admin-form-grid--three">' +
      '<label class="form-field"><span class="form-field__label">编辑格式</span><select name="format"><option value="markdown" selected>Markdown</option><option value="html">HTML</option></select></label>' +
      '<label class="form-field"><span class="form-field__label">发布状态</span><select name="status"><option value="published" selected>立即发布</option><option value="draft">保存草稿</option><option value="scheduled">定时发布</option></select></label>' +
      '<label class="form-field"><span class="form-field__label">定时发布时间</span><input type="datetime-local" name="publishAt" /></label>' +
      "</div>" +
      '<label class="form-field"><span class="form-field__label">文章封面</span><select name="coverMediaId"><option value="">不使用封面</option>' +
      adminMedia.map(function (asset) { return '<option value="' + escapeHtml(asset.id) + '">' + escapeHtml(asset.title || asset.alt || asset.id) + "</option>"; }).join("") +
      "</select></label>" +
      '<textarea name="excerpt" rows="3" maxlength="220" placeholder="文章摘要"></textarea>' +
      '<textarea name="content" rows="14" placeholder="使用 Markdown 写正文；切换为 HTML 后也会经过安全过滤"></textarea>' +
      '<div class="admin-editor-toolbar"><label class="button-secondary admin-upload-picker"><i class="fa-regular fa-image"></i> 选择图片<input id="adminArticleImage" type="file" accept="image/jpeg,image/png,image/webp,image/gif" /></label>' +
      '<button type="button" class="button-secondary" data-action="upload-admin-image"><i class="fa-solid fa-cloud-arrow-up"></i> 上传并插入</button>' +
      '<button type="button" class="button-secondary" data-action="preview-admin-article"><i class="fa-regular fa-eye"></i> 安全预览</button></div>' +
      '<p class="form-status" id="adminArticleWorkspaceStatus" role="status" aria-live="polite"></p>' +
      '<div class="admin-autosave"><span id="adminArticleAutosaveStatus">输入后会自动保存到当前浏览器。</span><button type="button" class="button-secondary" data-action="restore-admin-autosave" hidden>恢复自动保存</button></div>' +
      '<section class="admin-preview" aria-labelledby="adminPreviewTitle"><div class="admin-editor__header"><h3 id="adminPreviewTitle">安全预览</h3><span>服务端渲染并过滤危险内容</span></div><div id="adminArticlePreview" class="rich-content admin-preview__content"><p>开始输入正文后，这里会显示预览。</p></div></section>' +
      '<section class="admin-versions" id="adminArticleVersions"><p>编辑现有文章后，可在这里查看并恢复历史版本。</p></section>' +
      '<div class="comment-form__footer"><span>草稿不会公开；定时文章到点后自动对所有访客可见。</span><button type="submit" class="button-primary">保存文章</button></div>' +
      "</form></section>" +
      '<section class="admin-list-panel"><div class="admin-editor__header"><h3>文章列表</h3><span class="admin-count">共 ' +
      adminArticles.length +
      ' 篇</span></div><div class="admin-record-list">' +
      renderAdminArticleItems(adminArticles) +
      "</div></section>" +
      "</div></section>" +
      '<section class="admin-section admin-manager-section"><div class="panel-title"><i class="fa-regular fa-images"></i><span>媒体库与照片墙</span></div>' +
      '<div class="admin-media-upload"><input id="adminMediaUpload" type="file" accept="image/jpeg,image/png,image/webp,image/gif" />' +
      '<label class="admin-check"><input id="adminMediaIsPhoto" type="checkbox" checked /> 上传后加入照片墙</label>' +
      '<button type="button" class="button-primary" data-action="upload-admin-media"><i class="fa-solid fa-cloud-arrow-up"></i> 上传图片</button>' +
      '<p class="form-status" id="adminMediaStatus" role="status" aria-live="polite"></p></div>' +
      '<div class="admin-media-grid">' + renderAdminMediaItems(adminMedia) + "</div></section>" +
      '<section class="admin-section admin-manager-section">' +
      '<div class="panel-title"><i class="fa-solid fa-music"></i><span>音乐管理</span></div>' +
      '<div class="admin-manager-grid">' +
      '<section class="admin-editor">' +
      '<div class="admin-editor__header"><h3 id="adminTrackFormTitle">新增音乐</h3><button type="button" class="button-secondary" data-action="reset-admin-track">清空</button></div>' +
      '<form class="comment-form admin-form" id="adminTrackForm" data-form="admin-track">' +
      '<input type="hidden" name="currentId" value="" />' +
      '<div class="admin-form-grid admin-form-grid--two">' +
      '<input type="text" name="title" maxlength="80" placeholder="歌曲名称" />' +
      '<input type="text" name="id" maxlength="80" placeholder="歌曲 ID，例如 lemon" />' +
      "</div>" +
      '<div class="admin-form-grid admin-form-grid--three">' +
      '<input type="text" name="artist" maxlength="80" placeholder="歌手" />' +
      '<input type="text" name="subtitle" maxlength="140" placeholder="副标题" />' +
      '<input type="number" name="bpm" min="40" max="220" placeholder="BPM" />' +
      "</div>" +
      '<div class="admin-form-grid admin-form-grid--three">' +
      '<input type="text" name="coverLabel" maxlength="24" placeholder="封面文字" />' +
      '<input type="text" name="coverFrom" maxlength="20" placeholder="封面起始色，如 #6ea8ff" />' +
      '<input type="text" name="coverTo" maxlength="20" placeholder="封面结束色，如 #7267ff" />' +
      "</div>" +
      '<input type="text" name="audioUrl" maxlength="500" placeholder="音频链接，可选；为空时会使用下方音符 JSON 合成" />' +
      '<textarea name="notesJson" rows="8" placeholder=\'音符 JSON，例如 [{"frequency":392,"beats":0.6}]\'></textarea>' +
      '<div class="comment-form__footer"><span>可以填写音频链接，也可以继续用音符 JSON 生成旋律。</span><button type="submit" class="button-primary">保存音乐</button></div>' +
      "</form></section>" +
      '<section class="admin-list-panel"><div class="admin-editor__header"><h3>音乐列表</h3><span class="admin-count">共 ' +
      adminPlaylist.length +
      ' 首</span></div><div class="admin-record-list">' +
      renderAdminTrackItems(adminPlaylist) +
      "</div></section>" +
      "</div></section>" +
      '<section class="admin-section admin-manager-section">' +
      '<div class="panel-title"><i class="fa-solid fa-cloud-arrow-down"></i><span>从网易云导入音乐</span></div>' +
      '<div class="netease-import">' +
      '<div class="netease-import__search">' +
      '<input type="text" id="neteaseSearchInput" placeholder="输入歌曲名称或歌手搜索..." />' +
      '<button type="button" id="neteaseSearchBtn" class="button-primary">搜索</button>' +
      "</div>" +
      '<div id="neteaseResults" class="netease-results">' +
      '<div class="empty-state empty-state--compact">在上方搜索框输入关键词，从网易云音乐查找歌曲。</div>' +
      "</div>" +
      "</div>" +
      "</section>" +
      "</section>" +
      renderPlayerCard() +
      "</main>"
    );
  }

  function renderCommunityComposer() {
    return (
      '<section class="glass-panel page-panel community-composer" id="communityComposer">' +
      '<div class="page-heading"><div><h2>社区广场</h2><p>发布短文、交流感受，让整站多一点轻松互动。</p></div></div>' +
      '<form class="comment-form comment-form--community" data-form="community-post">' +
      createIdentityFields() +
      '<label class="form-field"><span class="form-field__label">帖子内容</span>' +
      '<textarea name="content" rows="4" maxlength="1000" placeholder="写下一段短文、状态或你想分享的片段..." required></textarea></label>' +
      renderFormStatus() +
      '<div class="comment-form__footer"><span>支持点赞、评论和分页浏览。</span><button type="submit" class="button-primary">发布帖子</button></div>' +
      "</form>" +
      "</section>"
    );
  }

  function renderCommunityGateway(pageData) {
    var postCount = pageData && pageData.community && pageData.community.pagination ? pageData.community.pagination.total : 0;

    return (
      '<section class="glass-panel page-panel community-gateway">' +
      '<div class="community-gateway__copy">' +
      "<span>Community Portal</span>" +
      "<h2>进入社区广场</h2>" +
      "<p>这里保留原有页面风格，并额外提供快捷跳转，让你可以快速前往发帖区、最新动态和文章页。</p>" +
      "</div>" +
      '<div class="community-gateway__actions">' +
      '<a class="button-primary" href="#communityComposer">去发帖</a>' +
      '<a class="button-secondary" href="#communityFeed">看动态</a>' +
      '<a class="button-secondary" href="/archive">看文章</a>' +
      "</div>" +
      '<div class="community-gateway__meta">' +
      "<div><span>当前帖子</span><strong>" +
      postCount +
      "</strong></div>" +
      "<div><span>当前页码</span><strong>" +
      ((pageData && pageData.community && pageData.community.pagination && pageData.community.pagination.page) || 1) +
      "</strong></div>" +
      "<div><span>互动方式</span><strong>发帖 / 评论 / 点赞</strong></div>" +
      "</div>" +
      "</section>"
    );
  }

  function renderCommunityComment(comment, postId) {
    return (
      '<article class="comment-item comment-item--community">' +
      '<img class="comment-avatar" src="' +
      escapeHtml(comment.author.avatar || "/images/avatar.jpg") +
      '" alt="' +
      escapeHtml(comment.author.name) +
      ' 头像" />' +
      '<div class="comment-body">' +
      '<div class="comment-meta"><strong>' +
      escapeHtml(comment.author.name) +
      "</strong><span>" +
      escapeHtml(formatRelativeTime(comment.createdAt)) +
      "</span></div>" +
      '<p class="comment-content">' +
      escapeHtml(comment.content) +
      "</p>" +
      '<div class="comment-actions">' +
      renderLikeButton({
        liked: comment.liked,
        count: comment.likes,
        attributes: {
          action: "like-community-comment",
          "post-id": postId,
          "comment-id": comment.id,
        },
      }) +
      (state.adminAuthenticated
        ? '<button type="button" class="comment-action comment-action--danger" data-action="delete-community-comment" data-post-id="' +
          escapeHtml(postId) +
          '" data-comment-id="' +
          escapeHtml(comment.id) +
          '"><i class="fa-regular fa-trash-can"></i><em>删除</em></button>'
        : "") +
      "</div>" +
      "</div>" +
      "</article>"
    );
  }

  function renderCommunityPost(post) {
    var comments = Array.isArray(post.comments) ? post.comments : [];

    return (
      '<article class="glass-panel page-panel community-post">' +
      '<div class="community-post__header">' +
      '<div class="community-post__author">' +
      '<img class="comment-avatar" src="' +
      escapeHtml(post.author.avatar || "/images/avatar.jpg") +
      '" alt="' +
      escapeHtml(post.author.name) +
      ' 头像" />' +
      "<div><strong>" +
      escapeHtml(post.author.name) +
      "</strong><span>" +
      escapeHtml(formatDateTimeLabel(post.createdAt)) +
      "</span></div>" +
      "</div>" +
      '<div class="community-post__badge">社区帖子</div>' +
      "</div>" +
      '<div class="community-post__content">' +
      escapeHtml(post.content).replace(/\n/g, "<br />") +
      "</div>" +
      '<div class="community-post__actions">' +
      renderLikeButton({
        liked: post.liked,
        count: post.likes,
        label: "点赞",
        attributes: {
          action: "like-community-post",
          "post-id": post.id,
        },
      }) +
      '<button type="button" class="comment-action" data-action="focus-community-comment" data-post-id="' +
      escapeHtml(post.id) +
      '"><i class="fa-regular fa-message"></i><span>' +
      comments.length +
      '</span><em>评论</em></button>' +
      (state.adminAuthenticated
        ? '<button type="button" class="comment-action comment-action--danger" data-action="delete-community-post" data-post-id="' +
          escapeHtml(post.id) +
          '"><i class="fa-regular fa-trash-can"></i><em>删除</em></button>'
        : "") +
      "</div>" +
      '<div class="community-post__comments">' +
      '<div class="community-post__comment-title">评论区</div>' +
      (comments.length
        ? comments
            .map(function (comment) {
              return renderCommunityComment(comment, post.id);
            })
            .join("")
        : '<div class="empty-state empty-state--compact">还没有评论，来做第一个留言的人吧。</div>') +
      '<form class="comment-form comment-form--inline" data-form="community-comment" data-post-id="' +
      escapeHtml(post.id) +
      '">' +
      createIdentityFields() +
      '<label class="form-field" for="community-comment-' +
      escapeHtml(post.id) +
      '"><span class="form-field__label">评论内容</span></label>' +
      '<textarea id="community-comment-' +
      escapeHtml(post.id) +
      '" name="content" rows="3" maxlength="600" placeholder="为这条动态写下你的评论..." required></textarea>' +
      renderFormStatus() +
      '<div class="comment-form__footer"><span>评论提交后会平滑刷新。</span><button type="submit" class="button-secondary">发表评论</button></div>' +
      "</form>" +
      "</div>" +
      "</article>"
    );
  }

  function getPaginationWindow(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, function (_item, index) { return index + 1; });
    }
    var pages = [1];
    var start = Math.max(2, current - 2);
    var end = Math.min(total - 1, current + 2);
    if (start > 2) pages.push("ellipsis-start");
    for (var page = start; page <= end; page += 1) pages.push(page);
    if (end < total - 1) pages.push("ellipsis-end");
    pages.push(total);
    return pages;
  }

  function renderCommunityPagination(pagination) {
    if (!pagination || pagination.totalPages <= 1) {
      return "";
    }

    return getPaginationWindow(pagination.page, pagination.totalPages)
      .map(function (page) {
        if (typeof page !== "number") return '<span class="pagination-ellipsis" aria-hidden="true">…</span>';
        return '<button type="button" class="pagination-button' + (page === pagination.page ? " is-active" : "") + '" data-action="community-page" data-page="' + page + '">' + page + "</button>";
      })
      .join("");
  }

  function renderArticlePagination(pagination, pathname) {
    if (!pagination || pagination.totalPages <= 1) {
      return "";
    }

    var buttons = getPaginationWindow(pagination.page, pagination.totalPages).map(function (page) {
      if (typeof page !== "number") return '<span class="pagination-ellipsis" aria-hidden="true">…</span>';
      var filters = Object.assign({}, state.route.filters, { page: page });
      return '<a class="pagination-button' + (page === pagination.page ? " is-active" : "") + '" href="' + pathname + serializeFilters(filters) + '">' + page + "</a>";
    });

    return '<div class="community-pagination article-pagination">' + buttons.join("") + "</div>";
  }

  function renderCommentReply(reply, articleSlug, commentId) {
    return (
      '<article class="comment-item comment-item--reply">' +
      '<img class="comment-avatar" src="' +
      escapeHtml(reply.author.avatar || "/images/avatar.jpg") +
      '" alt="' +
      escapeHtml(reply.author.name) +
      ' 头像" />' +
      '<div class="comment-body">' +
      '<div class="comment-meta"><strong>' +
      escapeHtml(reply.author.name) +
      "</strong><span>" +
      escapeHtml(formatRelativeTime(reply.createdAt)) +
      "</span></div>" +
      '<p class="comment-content">' +
      escapeHtml(reply.content) +
      "</p>" +
      '<div class="comment-actions">' +
      renderLikeButton({
        liked: reply.liked,
        count: reply.likes,
        attributes: {
          action: "like-article-reply",
          slug: articleSlug,
          "comment-id": commentId,
          "reply-id": reply.id,
        },
      }) +
      '<button type="button" class="comment-action comment-action--danger" data-action="delete-article-reply" data-slug="' +
      escapeHtml(articleSlug) +
      '" data-comment-id="' +
      escapeHtml(commentId) +
      '" data-reply-id="' +
      escapeHtml(reply.id) +
      '"><i class="fa-regular fa-trash-can"></i><em>删除</em></button>' +
      "</div>" +
      "</div>" +
      "</article>"
    );
  }

  function renderArticleComment(comment, articleSlug) {
    var replies = Array.isArray(comment.replies) ? comment.replies : [];

    return (
      '<article class="comment-item">' +
      '<img class="comment-avatar" src="' +
      escapeHtml(comment.author.avatar || "/images/avatar.jpg") +
      '" alt="' +
      escapeHtml(comment.author.name) +
      ' 头像" />' +
      '<div class="comment-body">' +
      '<div class="comment-meta"><strong>' +
      escapeHtml(comment.author.name) +
      "</strong><span>" +
      escapeHtml(formatDateTimeLabel(comment.createdAt)) +
      "</span></div>" +
      '<p class="comment-content">' +
      escapeHtml(comment.content) +
      "</p>" +
      '<div class="comment-actions">' +
      renderLikeButton({
        liked: comment.liked,
        count: comment.likes,
        label: "点赞",
        attributes: {
          action: "like-article-comment",
          slug: articleSlug,
          "comment-id": comment.id,
        },
      }) +
      '<button type="button" class="comment-action" data-action="toggle-reply-form" data-target="reply-form-' +
      escapeHtml(comment.id) +
      '"><i class="fa-regular fa-message"></i><em>回复</em></button>' +
      '<button type="button" class="comment-action comment-action--danger" data-action="delete-article-comment" data-slug="' +
      escapeHtml(articleSlug) +
      '" data-comment-id="' +
      escapeHtml(comment.id) +
      '"><i class="fa-regular fa-trash-can"></i><em>删除</em></button>' +
      "</div>" +
      (replies.length
        ? '<div class="comment-replies">' +
          replies
            .map(function (reply) {
              return renderCommentReply(reply, articleSlug, comment.id);
            })
            .join("") +
          "</div>"
        : "") +
      '<form class="comment-form comment-form--reply" data-form="article-comment" data-slug="' +
      escapeHtml(articleSlug) +
      '" data-parent-id="' +
      escapeHtml(comment.id) +
      '" id="reply-form-' +
      escapeHtml(comment.id) +
      '" hidden>' +
      createIdentityFields() +
      '<textarea name="content" rows="3" maxlength="600" placeholder="写下你的回复..."></textarea>' +
      '<div class="comment-form__footer"><span>回复会在当前评论下方更新。</span><button type="submit" class="button-secondary">提交回复</button></div>' +
      "</form>" +
      "</div>" +
      "</article>"
    );
  }

  function renderArticleCommentsSection(articleSlug, comments) {
    return (
      '<section class="glass-panel page-panel comments-panel" id="articleCommentsSection">' +
      '<div class="page-heading"><div><h2>文章评论</h2><p>欢迎留下你的看法、补充和感受。</p></div></div>' +
      '<form class="comment-form" data-form="article-comment" data-slug="' +
      escapeHtml(articleSlug) +
      '">' +
      createIdentityFields() +
      '<textarea name="content" rows="4" maxlength="600" placeholder="写下你的评论，让这篇文章更完整一点..."></textarea>' +
      '<div class="comment-form__footer"><span>支持回复、点赞和局部刷新。</span><button type="submit" class="button-primary">发表评论</button></div>' +
      "</form>" +
      '<div class="comments-stack">' +
      (comments.length
        ? comments
            .map(function (comment) {
              return renderArticleComment(comment, articleSlug);
            })
            .join("")
        : '<div class="empty-state">还没有评论，欢迎留下第一句留言。</div>') +
      "</div>" +
      "</section>"
    );
  }

  function renderArticleCommunityCta() {
    return (
      '<section class="glass-panel page-panel article-community-cta" aria-labelledby="articleCommunityTitle">' +
      '<div><p class="eyebrow">Community</p><h2 id="articleCommunityTitle">文章留言统一到社区</h2>' +
      '<p>文章页保留安静的阅读体验。想讨论内容、补充观点或和其他读者交流，请前往社区广场。</p></div>' +
      '<a class="button-primary" href="/community"><i class="fa-regular fa-comments"></i> 前往社区留言</a>' +
      "</section>"
    );
  }

  function renderArticleLikeBar(article) {
    return (
      '<div class="article-like-bar">' +
      renderLikeButton({
        liked: article.liked,
        count: article.likes,
        label: article.liked ? "取消点赞" : "点赞文章",
        attributes: {
          action: "like-article",
          slug: article.slug,
        },
      }) +
      "</div>"
    );
  }

  function renderCommunityMain(pageData) {
    return (
      '<main class="main-column">' +
      renderCommunityGateway(pageData) +
      renderCommunityComposer() +
      '<section class="community-feed" id="communityFeed">' +
      (pageData.community.items.length
        ? pageData.community.items.map(renderCommunityPost).join("")
        : '<section class="glass-panel page-panel"><div class="empty-state">社区里还没有动态，先来发布第一条状态吧。</div></section>') +
      "</section>" +
      '<div class="community-pagination" id="communityPagination">' +
      renderCommunityPagination(pageData.community.pagination) +
      "</div>" +
      renderPlayerCard() +
      "</main>"
    );
  }

  function renderHomeMain(pageData) {
    var featured = pageData.articles[0];
    var latest = pageData.articles.slice(0, 1);
    var stats = state.siteBundle.stats;

    return (
      '<main class="main-column main-column--home">' +
      '<section class="glass-panel hero-card">' +
      '<div class="hero-copy">' +
      '<div class="eyebrow">Cinematic Notes</div>' +
      "<h2>" +
      escapeHtml(featured ? featured.title : "朝花夕拾") +
      "</h2>" +
      '<p class="panel-copy">' +
      escapeHtml(featured ? featured.excerpt : state.siteBundle.site.tagline) +
      "</p>" +
      '<div class="hero-actions">' +
      '<a href="' +
      (featured ? "/articles/" + encodeURIComponent(featured.slug) : "/archive") +
      '" class="button-primary">阅读最新文章</a>' +
      '<a href="/about" class="button-secondary">了解更多</a>' +
      "</div>" +
      "</div>" +
      renderVideoCard("hero-media") +
      "</section>" +
      '<section class="glass-panel page-panel">' +
      '<div class="panel-title"><i class="fa-solid fa-clock-rotate-left"></i><span>最新文章</span></div>' +
      '<div class="post-stack">' +
      (latest.length ? latest.map(renderPostItem).join("") : '<div class="empty-state">暂无文章。</div>') +
      "</div>" +
      "</section>" +
      '<section class="feature-row">' +
      '<section class="glass-panel notice-panel">' +
      '<div class="panel-title"><i class="fa-solid fa-bullhorn"></i><span>公告</span></div>' +
      "<p>" +
      escapeHtml(state.siteBundle.announcement) +
      "</p>" +
      "</section>" +
      renderSiteInfo(stats) +
      "</section>" +
      renderPlayerCard() +
      "</main>"
    );
  }

  function renderArchiveMain(pageData) {
    var hasFilters =
      state.route.filters.search ||
      state.route.filters.date ||
      state.route.filters.category ||
      state.route.filters.tag;
    var headingMeta = hasFilters
      ? "当前筛选：" +
        [
          state.route.filters.search ? "搜索 " + state.route.filters.search : "",
          state.route.filters.date ? "日期 " + state.route.filters.date : "",
          state.route.filters.category ? "分类 " + state.route.filters.category : "",
          state.route.filters.tag ? "标签 " + state.route.filters.tag : "",
        ]
          .filter(Boolean)
          .join(" / ")
      : "按时间浏览所有文章";

    return (
      '<main class="main-column">' +
      '<section class="glass-panel page-panel">' +
      '<div class="page-heading"><div><h2>归档</h2><p>' +
      escapeHtml(headingMeta) +
      "</p></div></div>" +
      '<div class="post-stack">' +
      (pageData.articles.length
        ? pageData.articles.map(renderPostItem).join("")
        : '<div class="empty-state">没有匹配的文章。</div>') +
      "</div>" +
      "</section>" +
      "</main>"
    );
  }

  function renderCategoriesMain(pageData) {
    var items = state.siteBundle.categories;
    var selected = state.route.filters.category;

    return (
      '<main class="main-column">' +
      '<section class="glass-panel page-panel">' +
      '<div class="page-heading"><div><h2>分类</h2><p>按主题浏览文章内容。</p></div></div>' +
      '<div class="category-grid">' +
      items
        .map(function (item) {
          var href = "/categories" + serializeFilters({ category: item.name });
          return (
            '<a class="chip' +
            (selected === item.name ? " is-selected" : "") +
            '" href="' +
            href +
            '">' +
            "<strong>" +
            escapeHtml(item.name) +
            "</strong><span>" +
            item.count +
            " 篇文章</span></a>"
          );
        })
        .join("") +
      "</div>" +
      "</section>" +
      '<section class="glass-panel page-panel">' +
      '<div class="page-heading"><div><h2>' +
      escapeHtml(selected || "全部分类文章") +
      '</h2><p>点击卡片可切换筛选。</p></div><a class="button-secondary" href="/categories">清除筛选</a></div>' +
      '<div class="post-stack">' +
      (pageData.articles.length
        ? pageData.articles.map(renderPostItem).join("")
        : '<div class="empty-state">当前分类下暂无文章。</div>') +
      "</div>" +
      "</section>" +
      "</main>"
    );
  }

  function renderTagsMain(pageData) {
    var items = state.siteBundle.tags;
    var selected = state.route.filters.tag;

    return (
      '<main class="main-column">' +
      '<section class="glass-panel page-panel">' +
      '<div class="page-heading"><div><h2>标签</h2><p>从关键词切入浏览文章。</p></div></div>' +
      '<div class="tag-grid">' +
      items
        .map(function (item) {
          var href = "/tags" + serializeFilters({ tag: item.name });
          return (
            '<a class="chip' +
            (selected === item.name ? " is-selected" : "") +
            '" href="' +
            href +
            '">' +
            "<strong>#" +
            escapeHtml(item.name) +
            "</strong><span>" +
            item.count +
            " 篇文章</span></a>"
          );
        })
        .join("") +
      "</div>" +
      "</section>" +
      '<section class="glass-panel page-panel">' +
      '<div class="page-heading"><div><h2>' +
      escapeHtml(selected ? "#" + selected : "全部标签文章") +
      '</h2><p>点击标签卡片可切换筛选。</p></div><a class="button-secondary" href="/tags">清除筛选</a></div>' +
      '<div class="post-stack">' +
      (pageData.articles.length
        ? pageData.articles.map(renderPostItem).join("")
        : '<div class="empty-state">当前标签下暂无文章。</div>') +
      "</div>" +
      "</section>" +
      "</main>"
    );
  }

  function renderTimelineMain(pageData) {
    return (
      '<main class="main-column">' +
      '<section class="glass-panel page-panel page-panel--timeline">' +
      '<div class="page-heading"><div><h2>时光机</h2><p>按时间线回看保存下来的灵感与记录。</p></div></div>' +
      '<div class="time-axis">' +
      (pageData.timeline.length
        ? pageData.timeline
            .map(function (group) {
              var yearLabel = group.label || "";
              return (
                '<section class="time-axis__group">' +
                '<header class="time-axis__group-header"><div class="time-axis__group-title"><span class="time-axis__year-badge">' +
                escapeHtml(yearLabel) +
                "</span><span class='time-axis__group-count'>" +
                group.items.length +
                " 篇文章</span></div><span class='time-axis__group-note'>从新到旧</span></header>" +
                '<div class="time-axis__rail">' +
                group.items
                  .map(function (item) {
                    var articleUrl = "/articles/" + encodeURIComponent(item.slug);
                    return (
                      '<article class="time-axis__entry">' +
                      '<div class="time-axis__date"><strong>' +
                      escapeHtml(item.dateLabel || item.iso || "") +
                      "</strong><span>" +
                      escapeHtml(item.weekday || "") +
                      "</span></div>" +
                      '<div class="time-axis__node" aria-hidden="true"></div>' +
                      '<div class="time-axis__card">' +
                      '<div class="time-axis__meta"><span>' +
                      escapeHtml(item.category || "未分类") +
                      "</span>" +
                      (item.iso
                        ? '<time datetime="' + escapeHtml(item.iso) + '">' + escapeHtml(item.iso) + "</time>"
                        : "") +
                      "</div>" +
                      '<h3><a href="' +
                      articleUrl +
                      '">' +
                      escapeHtml(item.title) +
                      "</a></h3>" +
                      "<p>" +
                      escapeHtml(item.excerpt) +
                      '</p><div class="time-axis__footer"><a class="article-link time-axis__link" href="' +
                      articleUrl +
                      '">阅读全文</a></div>' +
                      "</article>"
                    );
                  })
                  .join("") +
                "</div>" +
                "</section>"
              );
            })
            .join("")
        : '<div class="empty-state">时间线中还没有内容。</div>') +
      "</div>" +
      "</section>" +
      "</main>"
    );
  }

  function getPhotoMonthLabel(value) {
    var date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "未标注时间";
    return date.getFullYear() + " 年 " + String(date.getMonth() + 1).padStart(2, "0") + " 月";
  }

  function renderPhotoExif(photo) {
    var exif = photo.exif || {};
    var items = [
      exif.camera ? "相机 " + exif.camera : "",
      exif.lens ? "镜头 " + exif.lens : "",
      exif.aperture ? "光圈 f/" + exif.aperture : "",
      exif.shutter ? "快门 " + exif.shutter + "s" : "",
      exif.iso ? "ISO " + exif.iso : "",
      exif.focalLength ? "焦距 " + exif.focalLength + "mm" : "",
    ].filter(Boolean);
    return items.length
      ? '<div class="photo-exif">' + items.map(function (item) { return "<span>" + escapeHtml(item) + "</span>"; }).join("") + "</div>"
      : "";
  }

  function renderPhotosMain(pageData) {
    var photos = Array.isArray(pageData.photos) ? pageData.photos : [];
    state.photoItems = photos;
    var groups = [];
    photos.forEach(function (photo, index) {
      var label = getPhotoMonthLabel(photo.takenAt || photo.createdAt);
      var group = groups.find(function (item) { return item.label === label; });
      if (!group) {
        group = { label: label, items: [] };
        groups.push(group);
      }
      group.items.push({ photo: photo, index: index });
    });

    return (
      '<main class="main-column photos-page"><section class="glass-panel page-panel">' +
      '<div class="page-heading"><div><p class="eyebrow">Photography</p><h2>照片墙</h2><p>按拍摄年月收藏生活里的光影与片刻。</p></div></div>' +
      (groups.length
        ? groups.map(function (group) {
            return (
              '<section class="photo-month"><div class="photo-month__heading"><h3>' + escapeHtml(group.label) + "</h3><span>" + group.items.length + " 张</span></div>" +
              '<div class="photo-grid">' +
              group.items.map(function (entry) {
                var photo = entry.photo;
                return (
                  '<button type="button" class="photo-tile" data-action="open-photo" data-photo-index="' + entry.index + '" aria-label="查看 ' + escapeHtml(photo.title || photo.alt || "照片") + '">' +
                  '<img src="' + escapeHtml(photo.thumbnailUrl || photo.url) + '" srcset="' + escapeHtml(photo.thumbnailUrl || photo.url) + " 480w, " + escapeHtml(photo.mediumUrl || photo.url) + ' 960w" sizes="(max-width: 760px) 50vw, 260px" alt="' + escapeHtml(photo.alt || photo.title || "照片") + '" loading="lazy" decoding="async" />' +
                  '<span><strong>' + escapeHtml(photo.title || "未命名照片") + "</strong>" + (photo.caption ? "<small>" + escapeHtml(photo.caption) + "</small>" : "") + "</span></button>"
                );
              }).join("") +
              "</div></section>"
            );
          }).join("")
        : '<div class="empty-state photo-empty"><i class="fa-regular fa-images"></i><h3>照片墙还没有内容</h3><p>站长可以在后台媒体库上传图片并设为照片墙公开照片。</p></div>') +
      "</section>" +
      '<div class="photo-lightbox" id="photoLightbox" role="dialog" aria-modal="true" aria-label="照片预览" hidden>' +
      '<button type="button" class="photo-lightbox__close" data-action="close-photo" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>' +
      '<button type="button" class="photo-lightbox__nav photo-lightbox__nav--prev" data-action="prev-photo" aria-label="上一张"><i class="fa-solid fa-angle-left"></i></button>' +
      '<figure><img id="photoLightboxImage" alt="" /><figcaption><h3 id="photoLightboxTitle"></h3><p id="photoLightboxCaption"></p><div id="photoLightboxExif"></div></figcaption></figure>' +
      '<button type="button" class="photo-lightbox__nav photo-lightbox__nav--next" data-action="next-photo" aria-label="下一张"><i class="fa-solid fa-angle-right"></i></button>' +
      "</div></main>"
    );
  }

  function updatePhotoLightbox(index) {
    if (!state.photoItems.length) return;
    state.activePhotoIndex = (index + state.photoItems.length) % state.photoItems.length;
    var photo = state.photoItems[state.activePhotoIndex];
    var lightbox = document.getElementById("photoLightbox");
    if (!lightbox) return;
    var image = document.getElementById("photoLightboxImage");
    if (image) {
      image.src = photo.largeUrl || photo.url;
      image.alt = photo.alt || photo.title || "照片";
    }
    var title = document.getElementById("photoLightboxTitle");
    if (title) title.textContent = photo.title || "未命名照片";
    var caption = document.getElementById("photoLightboxCaption");
    if (caption) caption.textContent = photo.caption || getPhotoMonthLabel(photo.takenAt || photo.createdAt);
    var exif = document.getElementById("photoLightboxExif");
    if (exif) exif.innerHTML = renderPhotoExif(photo);
  }

  function openPhotoLightbox(index) {
    var lightbox = document.getElementById("photoLightbox");
    if (!lightbox) return;
    updatePhotoLightbox(index);
    lightbox.hidden = false;
    document.body.classList.add("has-lightbox");
  }

  function closePhotoLightbox() {
    var lightbox = document.getElementById("photoLightbox");
    if (lightbox) lightbox.hidden = true;
    document.body.classList.remove("has-lightbox");
  }

  function renderAboutMain() {
    var profile = state.siteBundle.profile;

    return (
      '<main class="main-column">' +
      '<section class="glass-panel page-panel detail-panel">' +
      '<div class="detail-header"><h1>关于我</h1><p>' +
      escapeHtml(profile.bio) +
      "</p></div>" +
      renderVideoCard("detail-media") +
      '<div class="rich-content"><p>' + escapeHtml(profile.about) + "</p></div>" +
      "</section>" +
      "</main>"
    );
  }

  function renderArticleMain(pageData) {
    if (!pageData.article) {
      return (
        '<main class="main-column"><section class="glass-panel page-panel"><div class="empty-state">文章不存在或已被移除。</div></section></main>'
      );
    }

    var article = pageData.article;
    var related = pageData.related;
    var enriched = enhanceArticleContent(article.content || "");
    var toc = enriched.toc;
    var readingMinutes = estimateReadingMinutes(article);
    var articleIndex = Array.isArray(pageData.allArticles)
      ? pageData.allArticles.findIndex(function (item) {
          return item.slug === article.slug;
        })
      : -1;
    var articleNav = {
      prev: articleIndex > 0 ? pageData.allArticles[articleIndex - 1] : null,
      next:
        articleIndex >= 0 && Array.isArray(pageData.allArticles) && articleIndex < pageData.allArticles.length - 1
          ? pageData.allArticles[articleIndex + 1]
          : null,
    };

    return (
      '<main class="main-column">' +
      '<section class="glass-panel page-panel detail-panel">' +
      '<div class="detail-header">' +
      "<h1>" +
      escapeHtml(article.title) +
      "</h1>" +
      "<p>" +
      escapeHtml(article.excerpt) +
      "</p>" +
      '<div class="detail-meta">' +
      "<span><i class=\"fa-regular fa-calendar\"></i> " +
      escapeHtml(article.date.display) +
      "</span>" +
      "<span><i class=\"fa-regular fa-folder-open\"></i> " +
      escapeHtml(article.category) +
      "</span>" +
      "<span><i class=\"fa-regular fa-clock\"></i> " +
      readingMinutes +
      " 分钟阅读</span>" +
      "</div>" +
      '<div class="meta-pills">' +
      article.tags
        .map(function (tag) {
          return '<a href="/tags' + serializeFilters({ tag: tag }) + '">#' + escapeHtml(tag) + "</a>";
        })
        .join("") +
      "</div>" +
      "</div>" +
      renderArticleCover(article, "detail-media") +
      renderArticleToc(toc) +
      '<div class="rich-content">' +
      enriched.content +
      "</div>" +
      renderArticleShare(article) +
      renderArticleLikeBar(article) +
      "</section>" +
      renderArticleNav(articleNav) +
      renderArticleCommunityCta() +
      '<section class="glass-panel page-panel detail-related">' +
      "<h3>相关文章</h3>" +
      (related.length
        ? related.map(renderPostItem).join("")
        : '<div class="empty-state">暂无相关文章。</div>') +
      "</section>" +
      "</main>"
    );
  }

  function renderNotFoundMain() {
    return (
      '<main class="main-column"><section class="glass-panel page-panel detail-panel not-found-panel">' +
      '<div class="detail-header"><p class="eyebrow">404 · Not Found</p><h1>这里没有你要找的页面</h1>' +
      '<p>链接可能已经失效，也可能只是走进了一条还没写下故事的小路。</p></div>' +
      '<div class="hero-actions"><a class="button-primary" href="/">返回首页</a>' +
      '<a class="button-secondary" href="/archive">浏览全部文章</a></div>' +
      "</section></main>"
    );
  }

  function renderRightColumn() {
    var profile = state.siteBundle.profile;
    var stats = state.siteBundle.stats;

    return (
      '<aside class="right-column' +
      (state.route.pageType === "home" ? " right-column--home" : "") +
      '">' +
      '<section class="glass-panel profile-card">' +
      '<img class="profile-card__avatar" src="' +
      escapeHtml(profile.avatar) +
      '" alt="' +
      escapeHtml(profile.name) +
      ' 头像" />' +
      "<h3>" +
      escapeHtml(profile.name) +
      "</h3>" +
      '<p class="profile-card__tagline">' +
      escapeHtml(profile.bio) +
      "</p>" +
      '<div class="profile-card__meta">' +
      "<div><span>文章</span><strong>" +
      stats.articleCount +
      "</strong></div>" +
      "<div><span>标签</span><strong>" +
      stats.tagCount +
      "</strong></div>" +
      "<div><span>分类</span><strong>" +
      stats.categoryCount +
      "</strong></div>" +
      "</div>" +
      '<a class="profile-card__button" href="/about">Follow Me</a>' +
      "</section>" +
      '<section class="glass-panel calendar-card">' +
      '<div class="panel-title panel-title--between"><span>日历</span><span id="calendarDay">' +
      String(new Date().getDate()).padStart(2, "0") +
      '</span></div>' +
      '<div class="calendar-toolbar">' +
      '<button type="button" id="calendarPrev" aria-label="上个月"><i class="fa-solid fa-angle-left"></i></button>' +
      '<strong id="calendarMonth"></strong>' +
      '<button type="button" id="calendarNext" aria-label="下个月"><i class="fa-solid fa-angle-right"></i></button>' +
      "</div>" +
      '<div class="calendar-week" id="calendarWeek"></div>' +
      '<div class="calendar-grid" id="calendarGrid"></div>' +
      "</section>" +
      '<section class="glass-panel capsule-card">' +
      '<div class="panel-title"><i class="fa-solid fa-camera-retro"></i><span>时光机</span></div>' +
      renderVideoCard("capsule-card__media") +
      '<div class="capsule-card__text"><h4>穿越回过去的某一天。</h4>' +
      '<a class="capsule-card__button" href="/timeline">进入时光机</a></div>' +
      "</section>" +
      "</aside>"
    );
  }

  function renderSidebar() {
    var communityCurrent = state.route.pageType === "community";

    return (
      '<aside class="glass-panel side-nav">' +
      '<div class="brand-block"><h1>' +
      escapeHtml(state.siteBundle.site.title) +
      "</h1><p>" +
      escapeHtml(state.siteBundle.site.tagline) +
      "</p></div>" +
      '<nav class="menu-list" aria-label="主导航">' +
      state.siteBundle.navigation
        .map(function (item) {
          var current =
            (state.route.pageType === "home" && item.href === "/") ||
            (item.href !== "/" && state.route.path.indexOf(item.href) === 0);

          return (
            '<a class="menu-item' +
            (current ? " is-active" : "") +
            '" href="' +
            item.href +
            '"><i class="' +
            item.icon +
            '"></i><span>' +
            escapeHtml(item.label) +
            "</span></a>"
          );
        })
        .join("") +
      (state.siteBundle.navigation.some(function (item) { return item.href === "/photos"; })
        ? ""
        : '<a class="menu-item' + (state.route.pageType === "photos" ? " is-active" : "") + '" href="/photos"><i class="fa-regular fa-images"></i><span>照片墙</span></a>') +
      '<a class="menu-item' +
      (communityCurrent ? " is-active" : "") +
      '" href="/community"><i class="fa-regular fa-comments"></i><span>社区广场</span></a>' +
      "</nav>" +
      '<div class="side-nav__footer"><div class="side-nav__label">联系我</div>' +
      '<div class="social-dock">' +
      state.siteBundle.profile.socials
        .map(function (social) {
          return (
            '<a href="' +
            escapeHtml(social.url) +
            '" target="_blank" rel="noreferrer" aria-label="' +
            escapeHtml(social.label) +
            '"><i class="' +
            social.icon +
            '"></i></a>'
          );
        })
        .join("") +
      "</div>" +
      '<p class="side-nav__copyright">' + escapeHtml(state.siteBundle.site.copyright || "") + "</p>" +
      "</div>" +
      "</aside>"
    );
  }

  function renderTopbar() {
    return (
      '<header class="topbar">' +
      '<form class="search-form" id="searchForm">' +
      '<label class="search-box" aria-label="搜索">' +
      '<i class="fa-solid fa-magnifying-glass"></i>' +
      '<input id="searchInput" type="text" placeholder="搜索文章..." value="' +
      escapeHtml(state.route.filters.search) +
      '" />' +
      "</label>" +
      "</form>" +
      '<div class="topbar-actions">' +
      '<button class="audio-toggle-button" id="backgroundAudioToggle" type="button" aria-label="切换背景音">' +
      '<i class="fa-solid fa-wave-square"></i><span id="backgroundAudioState">' +
      (state.backgroundAudioEnabled ? "背景音开" : "背景音关") +
      "</span></button>" +
      '<div class="notification-menu"><button class="icon-button" id="notificationToggle" type="button" aria-label="通知" aria-expanded="false"><i class="fa-regular fa-bell"></i></button>' +
      '<div class="notification-panel" id="notificationPanel" hidden><div class="notification-panel__title"><strong>站点通知</strong><span>Announcement</span></div><p>' +
      escapeHtml(state.siteBundle.announcement || "暂时没有新公告。") +
      '</p><div class="notification-panel__actions"><a href="/community">前往社区</a><a href="/rss.xml" target="_blank">订阅 RSS</a></div></div></div>' +
      '<img class="topbar-avatar" src="' +
      escapeHtml(state.siteBundle.profile.avatar) +
      '" alt="' +
      escapeHtml(state.siteBundle.profile.name) +
      ' 头像" />' +
      "</div>" +
      "</header>"
    );
  }

  function renderLayout(mainHtml) {
    if (state.route.pageType === "admin" && !state.adminAuthenticated) {
      appRoot.innerHTML = '<div class="admin-login-shell">' + mainHtml + "</div>";
      return;
    }

    appRoot.innerHTML =
      '<div class="prototype-shell">' +
      renderSidebar() +
      renderTopbar() +
      (state.route.pageType === "article" ? '<div class="reading-progress"><span id="readingProgressBar"></span></div>' : "") +
      mainHtml +
      renderRightColumn() +
      (state.route.pageType === "home" ? "" : renderMiniPlayer()) +
      "</div>";
  }

  function cachePlayerRefs() {
    playerRefs = {
      playerCard: document.getElementById("playerCard"),
      coverImage: document.getElementById("coverImage"),
      songTitle: document.getElementById("songTitle"),
      songArtist: document.getElementById("songArtist"),
      songSubtitle: document.getElementById("songSubtitle"),
      currentTime: document.getElementById("currentTime"),
      durationTime: document.getElementById("durationTime"),
      progressRange: document.getElementById("progressRange"),
      volumeRange: document.getElementById("volumeRange"),
      muteButton: document.getElementById("muteButton"),
      playButton: document.getElementById("playButton"),
      prevButton: document.getElementById("prevButton"),
      nextButton: document.getElementById("nextButton"),
      playModeButton: document.getElementById("playModeButton"),
      playlistToggle: document.getElementById("playlistToggle"),
      playlistPanel: document.getElementById("playlistPanel"),
      playlistItems: document.getElementById("playlistItems"),
      playlistSummary: document.getElementById("playlistSummary"),
      miniPlayer: document.getElementById("miniPlayer"),
      miniCoverImage: document.getElementById("miniCoverImage"),
      miniTrackTitle: document.getElementById("miniTrackTitle"),
      miniTrackArtist: document.getElementById("miniTrackArtist"),
      miniPlayButton: document.getElementById("miniPlayButton"),
      miniPrevButton: document.getElementById("miniPrevButton"),
      miniNextButton: document.getElementById("miniNextButton"),
      miniPlayModeButton: document.getElementById("miniPlayModeButton"),
    };
  }

  function cacheCalendarRefs() {
    calendarRefs = {
      week: document.getElementById("calendarWeek"),
      grid: document.getElementById("calendarGrid"),
      month: document.getElementById("calendarMonth"),
      day: document.getElementById("calendarDay"),
      prev: document.getElementById("calendarPrev"),
      next: document.getElementById("calendarNext"),
    };
  }

  function cacheBackgroundRefs() {
    backgroundRefs = {
      toggle: document.getElementById("backgroundAudioToggle"),
      state: document.getElementById("backgroundAudioState"),
    };
  }

  function updatePlayButton(isPlaying) {
    if (playerRefs.playButton) {
      playerRefs.playButton.innerHTML = isPlaying
        ? '<i class="fa-solid fa-pause"></i>'
        : '<i class="fa-solid fa-play"></i>';
      playerRefs.playButton.setAttribute("aria-pressed", isPlaying ? "true" : "false");
      playerRefs.playButton.setAttribute("aria-label", isPlaying ? "暂停" : "播放");
    }

    if (playerRefs.playerCard) {
      playerRefs.playerCard.classList.toggle("is-playing", isPlaying);
    }

    if (playerRefs.miniPlayButton) {
      playerRefs.miniPlayButton.innerHTML = isPlaying
        ? '<i class="fa-solid fa-pause"></i>'
        : '<i class="fa-solid fa-play"></i>';
      playerRefs.miniPlayButton.setAttribute("aria-pressed", isPlaying ? "true" : "false");
      playerRefs.miniPlayButton.setAttribute("aria-label", isPlaying ? "暂停" : "播放");
    }

    if (playerRefs.miniPlayer) {
      playerRefs.miniPlayer.classList.toggle("is-playing", isPlaying);
    }

    syncPlaylistState();
  }

  function getActiveTrack() {
    return state.tracks[state.activeTrackIndex] || null;
  }

  function getTrackKey(track) {
    return String((track && (track.id || track.src)) || "");
  }

  function setPlayerStatus(message, tone) {
    state.playerStatus = String(message || "");
    state.playerStatusTone = String(tone || "");
    var track = getActiveTrack();
    var text = state.playerStatus || (track && track.subtitle) || "";

    if (playerRefs.songSubtitle) playerRefs.songSubtitle.textContent = text;
    if (playerRefs.miniTrackArtist) playerRefs.miniTrackArtist.textContent = state.playerStatus || (track && track.artist) || "";
    if (playerRefs.playerCard) playerRefs.playerCard.classList.toggle("has-error", tone === "error");
    if (playerRefs.miniPlayer) playerRefs.miniPlayer.classList.toggle("has-error", tone === "error");
  }

  function syncVolumeUI() {
    var volume = Number.isFinite(audio.volume) ? audio.volume : 0.75;
    if (playerRefs.volumeRange) playerRefs.volumeRange.value = String(Math.round(volume * 100));
    if (playerRefs.muteButton) {
      var muted = volume === 0;
      var low = volume > 0 && volume < 0.5;
      playerRefs.muteButton.innerHTML = muted
        ? '<i class="fa-solid fa-volume-xmark"></i>'
        : low
          ? '<i class="fa-solid fa-volume-low"></i>'
          : '<i class="fa-solid fa-volume-high"></i>';
      playerRefs.muteButton.setAttribute("aria-label", muted ? "恢复音量" : "静音");
      playerRefs.muteButton.setAttribute("aria-pressed", muted ? "true" : "false");
    }
  }

  function syncPlayerAudioMix() {
    if (!backgroundAudio || !state.backgroundAudioEnabled) return;
    backgroundAudio.volume = audio.paused ? 0.45 : 0.08;
  }

  function markTrackUnavailable(track) {
    var key = getTrackKey(track);
    if (key) state.unavailableTrackIds.add(key);
    syncPlaylistState();
  }

  function getPlayModeMeta() {
    var modes = {
      order: { label: "顺序播放", icon: "fa-arrow-right-long" },
      "repeat-all": { label: "列表循环", icon: "fa-repeat" },
      "repeat-one": { label: "单曲循环", icon: "fa-repeat", badge: "1" },
      shuffle: { label: "随机播放", icon: "fa-shuffle" },
    };
    return modes[state.playMode] || modes["repeat-all"];
  }

  function syncPlayModeUI() {
    var meta = getPlayModeMeta();
    var buttons = [playerRefs.playModeButton, playerRefs.miniPlayModeButton];
    buttons.forEach(function (button) {
      if (!button) return;
      button.innerHTML = '<i class="fa-solid ' + meta.icon + '"></i>' + (meta.badge ? '<small>' + meta.badge + "</small>" : "");
      button.setAttribute("aria-label", meta.label + "，点击切换");
      button.setAttribute("title", meta.label);
      button.setAttribute("data-mode", state.playMode);
    });
  }

  function cyclePlayMode() {
    var modes = ["order", "repeat-all", "repeat-one", "shuffle"];
    var currentIndex = modes.indexOf(state.playMode);
    state.playMode = modes[(currentIndex + 1 + modes.length) % modes.length];
    syncPlayModeUI();
    var notice = "已切换为" + getPlayModeMeta().label;
    setPlayerStatus(notice);
    window.clearTimeout(playerNoticeTimer);
    playerNoticeTimer = window.setTimeout(function () {
      if (state.playerStatus === notice) setPlayerStatus("");
    }, 1800);
    savePlayerState();
  }

  function findPlayableTrackIndex(direction, allowWrap) {
    if (!state.tracks.length) return -1;
    var step = direction < 0 ? -1 : 1;
    var maxOffset = allowWrap === false ? state.tracks.length - 1 : state.tracks.length;
    for (var offset = 1; offset <= maxOffset; offset += 1) {
      var rawIndex = state.activeTrackIndex + step * offset;
      if (allowWrap === false && (rawIndex < 0 || rawIndex >= state.tracks.length)) break;
      var index = (rawIndex + state.tracks.length) % state.tracks.length;
      if (!state.unavailableTrackIds.has(getTrackKey(state.tracks[index]))) return index;
    }
    return -1;
  }

  function findRandomPlayableTrackIndex() {
    var playableIndexes = state.tracks
      .map(function (_track, index) { return index; })
      .filter(function (index) {
        return index !== state.activeTrackIndex && !state.unavailableTrackIds.has(getTrackKey(state.tracks[index]));
      });
    if (!playableIndexes.length) {
      return state.tracks.length === 1 && !state.unavailableTrackIds.has(getTrackKey(state.tracks[0])) ? 0 : -1;
    }
    return playableIndexes[Math.floor(Math.random() * playableIndexes.length)];
  }

  function switchTrack(direction, shouldPlay, options) {
    var settings = options || {};
    var useShuffle = state.playMode === "shuffle" && settings.sequential !== true;
    var allowWrap = settings.allowWrap !== false;
    var nextIndex = useShuffle ? findRandomPlayableTrackIndex() : findPlayableTrackIndex(direction, allowWrap);
    if (nextIndex < 0) {
      state.playerWantsPlayback = false;
      setPlayerStatus(settings.endOfList ? "歌单已播放完毕" : "歌单中暂时没有可播放的音源", settings.endOfList ? "" : "error");
      updatePlayButton(false);
      savePlayerState();
      return;
    }
    loadTrack(nextIndex, shouldPlay);
  }

  function handleTrackEnded() {
    if (state.playMode === "repeat-one") {
      audio.currentTime = 0;
      audio.play().catch(function () {
        state.playerWantsPlayback = false;
        updatePlayButton(false);
        setPlayerStatus("无法重新播放当前歌曲", "error");
      });
      return;
    }

    if (state.playMode === "order") {
      switchTrack(1, true, { allowWrap: false, sequential: true, endOfList: true });
      return;
    }

    switchTrack(1, true);
  }

  function skipUnavailableTrack(track, message) {
    if (!track || getTrackKey(track) !== getTrackKey(getActiveTrack())) return;
    var shouldContinue = state.playerWantsPlayback;
    markTrackUnavailable(track);
    setPlayerStatus(message || "当前音源不可用，正在尝试下一首", "error");
    updatePlayButton(false);
    window.clearTimeout(playerSkipTimer);
    playerSkipTimer = window.setTimeout(function () {
      if (getTrackKey(track) === getTrackKey(getActiveTrack())) {
        switchTrack(1, shouldContinue, { sequential: true, allowWrap: state.playMode !== "order", endOfList: state.playMode === "order" });
      }
    }, 500);
  }

  function syncPlaylistState() {
    if (!playerRefs.playlistItems) return;

    Array.prototype.forEach.call(playerRefs.playlistItems.querySelectorAll("li"), function (item, index) {
      var unavailable = state.unavailableTrackIds.has(getTrackKey(state.tracks[index]));
      item.classList.toggle("is-active", index === state.activeTrackIndex);
      item.classList.toggle("is-unavailable", unavailable);
      item.setAttribute("aria-label", unavailable ? "音源不可用，点击重试" : "播放这首歌曲");
      var badge = item.querySelector("em");
      if (badge) badge.textContent = unavailable ? "不可用" : index === state.activeTrackIndex ? (audio.paused ? "当前" : "播放中") : "";
    });

    if (playerRefs.playlistSummary) {
      var unavailableCount = state.tracks.filter(function (track) {
        return state.unavailableTrackIds.has(getTrackKey(track));
      }).length;
      playerRefs.playlistSummary.textContent =
        state.tracks.length - unavailableCount + "/" + state.tracks.length + " · " + getPlayModeMeta().label;
    }
  }

  function syncPlayerUI() {
    if (!state.tracks.length) {
      if (playerRefs.songTitle) playerRefs.songTitle.textContent = "暂无音乐";
      if (playerRefs.songArtist) playerRefs.songArtist.textContent = "歌单为空";
      if (playerRefs.songSubtitle) playerRefs.songSubtitle.textContent = "站长添加音乐后即可播放";
      if (playerRefs.miniTrackTitle) playerRefs.miniTrackTitle.textContent = "暂无音乐";
      if (playerRefs.miniTrackArtist) playerRefs.miniTrackArtist.textContent = "歌单为空";
      [playerRefs.playButton, playerRefs.prevButton, playerRefs.nextButton, playerRefs.miniPlayButton, playerRefs.miniPrevButton, playerRefs.miniNextButton].forEach(function (button) {
        if (button) button.disabled = true;
      });
      if (playerRefs.playerCard) playerRefs.playerCard.classList.add("is-empty");
      if (playerRefs.miniPlayer) playerRefs.miniPlayer.classList.add("is-empty");
      syncPlayModeUI();
      return;
    }

    var track = state.tracks[state.activeTrackIndex];

    [playerRefs.playButton, playerRefs.prevButton, playerRefs.nextButton, playerRefs.miniPlayButton, playerRefs.miniPrevButton, playerRefs.miniNextButton].forEach(function (button) {
      if (button) button.disabled = false;
    });
    if (playerRefs.playerCard) playerRefs.playerCard.classList.remove("is-empty");
    if (playerRefs.miniPlayer) playerRefs.miniPlayer.classList.remove("is-empty");

    if (playerRefs.songTitle) playerRefs.songTitle.textContent = track.title;
    if (playerRefs.songArtist) playerRefs.songArtist.textContent = track.artist;
    if (playerRefs.songSubtitle) playerRefs.songSubtitle.textContent = state.playerStatus || track.subtitle;
    if (playerRefs.coverImage) {
      playerRefs.coverImage.src = track.cover;
      playerRefs.coverImage.alt = track.title + " 专辑封面";
      playerRefs.coverImage.onerror = function () {
        this.onerror = null;
        this.src = createCover(track.title.slice(0, 8), "#6ea8ff", "#7267ff");
      };
    }
    if (playerRefs.playlistPanel) {
      playerRefs.playlistPanel.hidden = !state.playlistOpen;
    }
    if (playerRefs.playlistToggle) {
      playerRefs.playlistToggle.classList.toggle("is-active", state.playlistOpen);
      playerRefs.playlistToggle.setAttribute("aria-expanded", state.playlistOpen ? "true" : "false");
    }
    syncPlayModeUI();
    syncVolumeUI();
    if (playerRefs.currentTime) {
      playerRefs.currentTime.textContent = formatTime(audio.currentTime);
    }
    if (playerRefs.durationTime) {
      playerRefs.durationTime.textContent = formatTime(audio.duration);
    }
    if (playerRefs.progressRange) {
      playerRefs.progressRange.value = audio.duration ? String((audio.currentTime / audio.duration) * 100) : "0";
    }
    if (playerRefs.miniCoverImage) {
      playerRefs.miniCoverImage.src = track.cover;
      playerRefs.miniCoverImage.alt = track.title + " 专辑封面";
      playerRefs.miniCoverImage.onerror = function () {
        this.onerror = null;
        this.src = createCover(track.title.slice(0, 8), "#6ea8ff", "#7267ff");
      };
    }
    if (playerRefs.miniTrackTitle) {
      playerRefs.miniTrackTitle.textContent = track.title;
    }
    if (playerRefs.miniTrackArtist) {
      playerRefs.miniTrackArtist.textContent = state.playerStatus || track.artist;
    }
    setPlayerStatus(state.playerStatus, state.playerStatusTone);
    updatePlayButton(!audio.paused);
    syncPlaylistState();
  }

  function getPlayerStatePayload() {
    var track = getActiveTrack();
    return {
      trackIndex: state.activeTrackIndex,
      trackId: track ? track.id : "",
      currentTime: Number(audio.currentTime || 0),
      playing: !audio.paused,
      volume: Number.isFinite(audio.volume) ? audio.volume : 0.75,
      playlistOpen: state.playlistOpen,
      playMode: state.playMode,
      updatedAt: new Date().toISOString(),
    };
  }

  function savePlayerState(options) {
    var payload = getPlayerStatePayload();
    writeStoredJson("blog-player-state", payload);

    if (options && options.remote === false) {
      return Promise.resolve(payload);
    }

    window.clearTimeout(playerRemoteSaveTimer);
    playerRemoteSaveTimer = window.setTimeout(function () {
      apiSend("/api/player/state", "POST", payload).catch(function () {});
    }, 450);
    return Promise.resolve(payload);
  }

  function restorePlayerState(remoteState) {
    var localState = readStoredJson("blog-player-state");
    var remoteTime = remoteState && remoteState.updatedAt ? new Date(remoteState.updatedAt).getTime() : 0;
    var localTime = localState && localState.updatedAt ? new Date(localState.updatedAt).getTime() : 0;
    var savedState = localState && (!remoteState || localTime >= remoteTime) ? localState : remoteState;

    if (savedState) {
      var savedTrackIndex = state.tracks.findIndex(function (track) {
        return savedState.trackId && track.id === savedState.trackId;
      });
      state.activeTrackIndex = savedTrackIndex >= 0 ? savedTrackIndex : Math.max(0, Number(savedState.trackIndex || 0));
      if (Object.prototype.hasOwnProperty.call(savedState, "playlistOpen")) {
        state.playlistOpen = Boolean(savedState.playlistOpen);
      }
      if (["order", "repeat-all", "repeat-one", "shuffle"].indexOf(savedState.playMode) >= 0) {
        state.playMode = savedState.playMode;
      }
      var savedVolume = Number(savedState.volume);
      audio.volume = Number.isFinite(savedVolume) ? Math.max(0, Math.min(1, savedVolume)) : 0.75;
      if (audio.volume > 0) state.previousPlayerVolume = audio.volume;
      loadTrack(state.activeTrackIndex, false);
      state.playerWantsPlayback = Boolean(savedState.playing);

      if (Number(savedState.currentTime || 0) > 0 || savedState.playing) {
        var restored = false;

        function onRestoreState() {
          if (restored) return;
          restored = true;
          audio.currentTime = Math.min(Number(savedState.currentTime || 0), Number(audio.duration || savedState.currentTime || 0));
          if (savedState.playing) {
            audio.play().catch(function () {
              updatePlayButton(false);
              setPlayerStatus("点击播放按钮继续收听");
            });
          } else {
            syncPlayerUI();
          }
          savePlayerState({ remote: false });
        }

        audio.addEventListener("loadedmetadata", onRestoreState, { once: true });
        audio.addEventListener("error", onRestoreState, { once: true });
        setTimeout(function () {
          if (!restored) {
            restored = true;
            savePlayerState({ remote: false });
            syncPlayerUI();
          }
        }, 5000);
        return;
      }
    }

    audio.volume = Number.isFinite(audio.volume) ? audio.volume : 0.75;
    loadTrack(state.activeTrackIndex, false);
    savePlayerState({ remote: false });
  }

  function syncBackgroundAudioUI() {
    if (!backgroundRefs.toggle || !backgroundRefs.state) return;

    backgroundRefs.toggle.classList.toggle("is-active", state.backgroundAudioEnabled);
    backgroundRefs.toggle.setAttribute("aria-pressed", state.backgroundAudioEnabled ? "true" : "false");
    backgroundRefs.state.textContent = state.backgroundAudioEnabled ? "背景音开" : "背景音关";
  }

  function renderPlaylist() {
    if (!playerRefs.playlistItems) return;

    playerRefs.playlistItems.innerHTML = state.tracks
      .map(function (track, index) {
        return (
          '<li data-index="' +
          index +
          '"><div><strong>' +
          escapeHtml(track.title) +
          "</strong><span>" +
          escapeHtml(track.artist) +
          "</span></div><em></em></li>"
        );
      })
      .join("");

    syncPlaylistState();
  }

  function loadTrack(index, shouldPlay) {
    if (!state.tracks.length) return;

    state.activeTrackIndex = (index + state.tracks.length) % state.tracks.length;
    var track = state.tracks[state.activeTrackIndex];
    var wasPaused = audio.paused;
    var shouldStart = shouldPlay === true || (!wasPaused && shouldPlay !== false);
    state.playerWantsPlayback = shouldStart;
    state.lastPlayerAutoSyncSecond = -1;
    window.clearTimeout(playerSkipTimer);

    if (!track.src) {
      skipUnavailableTrack(track, "这首歌没有可用的音频来源，正在跳过");
      return;
    }

    setPlayerStatus("正在加载 " + track.title + "…");
    audio.dataset.trackId = getTrackKey(track);
    audio.src = track.src;
    audio.load();
    syncPlayerUI();
    savePlayerState({ remote: false });

    if (shouldStart) {
      audio.play().catch(function (error) {
        if (error && error.name === "NotAllowedError") {
          state.playerWantsPlayback = false;
          setPlayerStatus("浏览器阻止了自动播放，请点击播放按钮");
        }
        updatePlayButton(false);
      });
    } else {
      updatePlayButton(false);
    }
  }

  function togglePlayerPlayback() {
    var track = getActiveTrack();
    if (!track) return;

    if (!audio.paused) {
      state.playerWantsPlayback = false;
      audio.pause();
      return;
    }

    state.playerWantsPlayback = true;
    if (!audio.src || state.unavailableTrackIds.has(getTrackKey(track))) {
      state.unavailableTrackIds.delete(getTrackKey(track));
      loadTrack(state.activeTrackIndex, true);
      return;
    }

    setPlayerStatus("正在开始播放…");
    audio.play().catch(function (error) {
      state.playerWantsPlayback = false;
      updatePlayButton(false);
      setPlayerStatus(error && error.name === "NotAllowedError" ? "请再次点击播放按钮" : "暂时无法开始播放", "error");
    });
  }

  function syncBackgroundSourcePosition() {
    if (!backgroundVideo || !backgroundAudio) return;

    if (backgroundVideo.readyState > 0 && Math.abs(backgroundVideo.currentTime - backgroundAudio.currentTime) > 1.2) {
      try {
        backgroundAudio.currentTime = backgroundVideo.currentTime;
      } catch (_error) {
        return;
      }
    }
  }

  function tryEnableBackgroundAudio() {
    if (!state.backgroundAudioEnabled) return Promise.resolve();

    backgroundAudio.volume = audio.paused ? 0.45 : 0.08;
    syncBackgroundSourcePosition();
    return backgroundAudio.play().catch(function () {
      state.backgroundAudioEnabled = false;
      writeStoredBool("blog-background-audio", false);
      syncBackgroundAudioUI();
    });
  }

  function toggleBackgroundAudio() {
    state.backgroundAudioEnabled = !state.backgroundAudioEnabled;
    writeStoredBool("blog-background-audio", state.backgroundAudioEnabled);
    syncBackgroundAudioUI();

    if (!state.backgroundAudioEnabled) {
      backgroundAudio.pause();
      return;
    }

    tryEnableBackgroundAudio();
  }

  function bindPlayerEvents() {
    if (playerEventsBound) return;
    playerEventsBound = true;

    audio.addEventListener("loadedmetadata", function () {
      var track = getActiveTrack();
      if (playerRefs.durationTime) {
        playerRefs.durationTime.textContent = formatTime(audio.duration);
      }
      syncPlayerUI();
      if (track && track.sourceType === "netease" && audio.duration < 0.5) {
        skipUnavailableTrack(track, "该歌曲受版权限制，正在尝试下一首");
      }
    });

    audio.addEventListener("waiting", function () {
      if (getActiveTrack()) setPlayerStatus("缓冲中…");
    });

    audio.addEventListener("canplay", function () {
      if (getActiveTrack()) setPlayerStatus("");
    });

    audio.addEventListener("timeupdate", function () {
      if (playerRefs.currentTime) {
        playerRefs.currentTime.textContent = formatTime(audio.currentTime);
      }
      if (playerRefs.progressRange && audio.duration) {
        playerRefs.progressRange.value = (audio.currentTime / audio.duration) * 100;
      }
      var currentSecond = Math.floor(audio.currentTime || 0);
      if (currentSecond !== state.lastPlayerAutoSyncSecond) {
        state.lastPlayerAutoSyncSecond = currentSecond;
        savePlayerState({ remote: false });
      }
    });

    audio.addEventListener("play", function () {
      state.playerWantsPlayback = true;
      setPlayerStatus("");
      updatePlayButton(true);
      syncPlayerAudioMix();
      savePlayerState();
    });

    audio.addEventListener("pause", function () {
      updatePlayButton(false);
      syncPlayerAudioMix();
      savePlayerState();
    });

    audio.addEventListener("ended", function () {
      handleTrackEnded();
    });

    audio.addEventListener("error", function () {
      var errorMessage = "音频加载失败";
      var errorCode = audio.error ? audio.error.code : 0;
      if (audio.error) {
        switch (errorCode) {
          case MediaError.MEDIA_ERR_ABORTED: errorMessage = "音频加载被中断"; break;
          case MediaError.MEDIA_ERR_NETWORK: errorMessage = "音频网络错误"; break;
          case MediaError.MEDIA_ERR_DECODE: errorMessage = "音频解码失败"; break;
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: errorMessage = "该歌曲受版权保护或格式不兼容"; break;
        }
      }
      if (errorCode === 1) return;
      skipUnavailableTrack(getActiveTrack(), errorMessage + "，正在尝试下一首");
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        savePlayerState();
      }
    });

    window.addEventListener("beforeunload", function () {
      savePlayerState({ remote: false });
    });
  }

  function bindBackgroundEvents() {
    if (backgroundEventsBound) return;
    backgroundEventsBound = true;

    if (backgroundVideo) {
      backgroundVideo.addEventListener("timeupdate", syncBackgroundSourcePosition);
      backgroundVideo.addEventListener("play", syncBackgroundSourcePosition);
      backgroundVideo.addEventListener("seeked", syncBackgroundSourcePosition);
    }

    document.addEventListener(
      "click",
      function () {
        if (state.backgroundAudioEnabled && backgroundAudio.paused) {
          tryEnableBackgroundAudio();
        }
      },
      { passive: true }
    );
  }

  function renderCalendar() {
    if (!calendarRefs.grid || !calendarRefs.week) return;

    var year = state.calendarState.year;
    var month = state.calendarState.month;
    var selectedDate = state.route.filters.date;
    var firstDay = new Date(year, month, 1).getDay();
    var lastDate = new Date(year, month + 1, 0).getDate();
    var today = new Date();
    var articleDates = new Set(
      (state.latestArticles || []).map(function (article) {
        return article.date.iso;
      })
    );
    var cells = [];

    calendarRefs.week.innerHTML = weekNames
      .map(function (name) {
        return "<span>" + name + "</span>";
      })
      .join("");

    calendarRefs.month.textContent = year + "年" + (month + 1) + "月";
    calendarRefs.day.textContent = String(today.getDate()).padStart(2, "0");

    for (var i = 0; i < firstDay; i += 1) {
      cells.push('<span class="is-ghost"></span>');
    }

    for (var date = 1; date <= lastDate; date += 1) {
      var iso = year + "-" + String(month + 1).padStart(2, "0") + "-" + String(date).padStart(2, "0");
      var classNames = [];
      var isToday =
        year === today.getFullYear() &&
        month === today.getMonth() &&
        date === today.getDate();

      if (isToday) classNames.push("is-today");
      if (selectedDate === iso) classNames.push("is-selected");
      if (articleDates.has(iso)) classNames.push("has-posts");

      cells.push(
        '<button type="button" class="' +
          classNames.join(" ") +
          '" data-date="' +
          iso +
          '">' +
          date +
          "</button>"
      );
    }

    calendarRefs.grid.innerHTML = cells.join("");
  }

  function refreshArticleComments(slug) {
    return apiFetch("/api/articles/" + encodeURIComponent(slug) + "/comments").then(function (result) {
      var section = document.getElementById("articleCommentsSection");
      if (section) {
        section.outerHTML = renderArticleCommentsSection(slug, result.items);
        bindRenderedEvents();
      }
    });
  }

  function refreshCommunityFeed(page) {
    return apiFetch("/api/community?page=" + page + "&limit=4").then(function (result) {
      var feed = document.getElementById("communityFeed");
      var pagination = document.getElementById("communityPagination");

      state.route.communityPage = result.pagination.page;

      if (feed) {
        feed.innerHTML = result.items.length
          ? result.items.map(renderCommunityPost).join("")
          : '<section class="glass-panel page-panel"><div class="empty-state">社区里还没有动态，先来发布第一条状态吧。</div></section>';
      }

      if (pagination) {
        pagination.innerHTML = renderCommunityPagination(result.pagination);
      }

      bindRenderedEvents();
    });
  }

  function toDateTimeLocalValue(value) {
    if (!value) return "";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return (
      date.getFullYear() +
      "-" +
      String(date.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(date.getDate()).padStart(2, "0") +
      "T" +
      String(date.getHours()).padStart(2, "0") +
      ":" +
      String(date.getMinutes()).padStart(2, "0")
    );
  }

  function getAdminArticlePayload(form) {
    if (!form) return {};
    var formData = new FormData(form);
    return {
      currentSlug: String(formData.get("currentSlug") || "").trim(),
      title: String(formData.get("title") || "").trim(),
      slug: String(formData.get("slug") || "").trim(),
      date: String(formData.get("date") || "").trim(),
      category: String(formData.get("category") || "").trim(),
      tags: String(formData.get("tags") || "").trim(),
      excerpt: String(formData.get("excerpt") || "").trim(),
      content: String(formData.get("content") || ""),
      format: String(formData.get("format") || "markdown"),
      status: String(formData.get("status") || "published"),
      publishAt: String(formData.get("publishAt") || "").trim(),
      coverMediaId: String(formData.get("coverMediaId") || "").trim(),
    };
  }

  function setAdminWorkspaceStatus(message, tone) {
    var status = document.getElementById("adminArticleWorkspaceStatus");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("is-error", tone === "error");
    status.classList.toggle("is-success", tone === "success");
  }

  function previewAdminArticle() {
    var form = document.getElementById("adminArticleForm");
    var preview = document.getElementById("adminArticlePreview");
    if (!form || !preview) return Promise.resolve();
    var payload = getAdminArticlePayload(form);

    return apiSend("/api/admin/articles/preview", "POST", {
      content: payload.content,
      format: payload.format,
    })
      .then(function (result) {
        preview.innerHTML = result.html || '<p class="panel-copy">正文为空。</p>';
        setAdminWorkspaceStatus("预览已更新。", "success");
      })
      .catch(function (error) {
        setAdminWorkspaceStatus(error.message || "预览失败。", "error");
      });
  }

  function renderAdminArticleVersions(slug, items) {
    var panel = document.getElementById("adminArticleVersions");
    if (!panel) return;
    if (!items.length) {
      panel.innerHTML = "<p>这篇文章还没有历史版本。</p>";
      return;
    }

    panel.innerHTML =
      '<div class="admin-editor__header"><h3>版本历史</h3><span>最多保留 30 个版本</span></div><div class="admin-version-list">' +
      items
        .map(function (version) {
          return (
            '<article class="admin-version-item"><div><strong>' +
            escapeHtml(version.title || "未命名版本") +
            "</strong><span>" +
            escapeHtml(formatDateTimeLabel(version.createdAt)) +
            " · " +
            escapeHtml(version.reason || "edit") +
            '</span></div><button type="button" class="button-secondary" data-restore-version="' +
            escapeHtml(version.id) +
            '">恢复</button></article>'
          );
        })
        .join("") +
      "</div>";

    panel.querySelectorAll("[data-restore-version]").forEach(function (button) {
      button.onclick = function () {
        if (!window.confirm("恢复该历史版本吗？当前内容会先自动保存为一个版本。")) return;
        button.disabled = true;
        apiSend(
          "/api/admin/articles/" + encodeURIComponent(slug) + "/versions/" + encodeURIComponent(button.dataset.restoreVersion) + "/restore",
          "POST"
        )
          .then(function () {
            removeStoredValue("blog-admin-article-autosave");
            renderCurrentRoute();
          })
          .catch(function (error) {
            button.disabled = false;
            setAdminWorkspaceStatus(error.message || "版本恢复失败。", "error");
          });
      };
    });
  }

  function loadAdminArticleVersions(slug) {
    var panel = document.getElementById("adminArticleVersions");
    if (!panel || !slug) return;
    panel.innerHTML = "<p>正在读取版本历史…</p>";
    apiFetch("/api/admin/articles/" + encodeURIComponent(slug) + "/versions")
      .then(function (result) {
        renderAdminArticleVersions(slug, result.items || []);
      })
      .catch(function (error) {
        panel.innerHTML = '<p class="form-status is-error">' + escapeHtml(error.message || "版本历史加载失败。") + "</p>";
      });
  }

  function bindAdminArticleWorkspace() {
    var form = document.getElementById("adminArticleForm");
    if (!form) return;
    var autosaveStatus = document.getElementById("adminArticleAutosaveStatus");
    var restoreButton = document.querySelector('[data-action="restore-admin-autosave"]');
    var saved = readStoredJson("blog-admin-article-autosave");

    if (!form.elements.date.value) {
      form.elements.date.value = new Date().toISOString().slice(0, 10);
    }

    if (saved && saved.fields) {
      if (autosaveStatus) autosaveStatus.textContent = "发现 " + formatDateTimeLabel(saved.savedAt) + " 的自动保存。";
      if (restoreButton) restoreButton.hidden = false;
    }

    form.addEventListener("input", function (event) {
      window.clearTimeout(adminArticleAutosaveTimer);
      adminArticleAutosaveTimer = window.setTimeout(function () {
        writeStoredJson("blog-admin-article-autosave", {
          savedAt: new Date().toISOString(),
          fields: getAdminArticlePayload(form),
        });
        if (autosaveStatus) autosaveStatus.textContent = "已自动保存于 " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
        if (restoreButton) restoreButton.hidden = true;
      }, 600);

      if (event.target && (event.target.name === "content" || event.target.name === "format")) {
        window.clearTimeout(adminArticlePreviewTimer);
        adminArticlePreviewTimer = window.setTimeout(previewAdminArticle, 900);
      }
    });
  }

  function restoreAdminArticleAutosave() {
    var form = document.getElementById("adminArticleForm");
    var saved = readStoredJson("blog-admin-article-autosave");
    if (!form || !saved || !saved.fields) return;
    Object.keys(saved.fields).forEach(function (name) {
      if (form.elements[name]) form.elements[name].value = saved.fields[name] || "";
    });
    var title = document.getElementById("adminArticleFormTitle");
    if (title) title.textContent = saved.fields.currentSlug ? "继续编辑文章" : "恢复未保存草稿";
    setAdminWorkspaceStatus("已恢复浏览器中的自动保存。", "success");
    previewAdminArticle();
  }

  function uploadAdminArticleImage(button) {
    var form = document.getElementById("adminArticleForm");
    var input = document.getElementById("adminArticleImage");
    var file = input && input.files ? input.files[0] : null;
    if (!form || !file) {
      setAdminWorkspaceStatus("请先选择一张图片。", "error");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setAdminWorkspaceStatus("图片不能超过 5 MB。", "error");
      return;
    }

    var data = new FormData();
    data.append("image", file);
    if (button) button.disabled = true;
    setAdminWorkspaceStatus("正在上传图片…");

    apiUpload("/api/admin/uploads", data)
      .then(function (result) {
        var textarea = form.elements.content;
        var format = form.elements.format ? form.elements.format.value : "markdown";
        var alt = String(file.name || "图片").replace(/\.[^.]+$/, "").replace(/[\[\]]/g, "");
        var insertion =
          format === "markdown"
            ? "\n![" + alt + "](" + result.url + ")\n"
            : '\n<img src="' + result.url + '" alt="' + escapeHtml(alt) + '" loading="lazy" />\n';
        var start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
        var end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start;
        textarea.value = textarea.value.slice(0, start) + insertion + textarea.value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + insertion.length;
        input.value = "";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.focus();
        setAdminWorkspaceStatus("图片已上传并插入正文。", "success");
      })
      .catch(function (error) {
        setAdminWorkspaceStatus(error.message || "图片上传失败。", "error");
      })
      .finally(function () {
        if (button) button.disabled = false;
      });
  }

  function setAdminMediaStatus(message, tone) {
    var status = document.getElementById("adminMediaStatus");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("is-error", tone === "error");
    status.classList.toggle("is-success", tone === "success");
  }

  function uploadAdminMedia(button) {
    var input = document.getElementById("adminMediaUpload");
    var file = input && input.files ? input.files[0] : null;
    if (!file) {
      setAdminMediaStatus("请先选择一张图片。", "error");
      return;
    }

    var formData = new FormData();
    formData.append("image", file);
    formData.append("isPhoto", document.getElementById("adminMediaIsPhoto").checked ? "true" : "false");
    if (button) button.disabled = true;
    setAdminMediaStatus("正在生成缩略图并读取 EXIF…");
    apiUpload("/api/admin/uploads", formData)
      .then(function () {
        setAdminMediaStatus("图片已加入媒体库。", "success");
        renderCurrentRoute();
      })
      .catch(function (error) {
        setAdminMediaStatus(error.message || "图片上传失败。", "error");
      })
      .finally(function () {
        if (button) button.disabled = false;
      });
  }

  function getAdminMediaCardPayload(card) {
    function field(name) { return card.querySelector('[data-media-field="' + name + '"]'); }
    var takenAt = field("takenAt").value;
    return {
      title: field("title").value.trim(),
      alt: field("alt").value.trim(),
      caption: field("caption").value.trim(),
      takenAt: takenAt && !Number.isNaN(new Date(takenAt).getTime()) ? new Date(takenAt).toISOString() : "",
      status: field("status").value,
      isPhoto: field("isPhoto").checked,
    };
  }

  function saveAdminMedia(card, button) {
    if (!card) return;
    if (button) button.disabled = true;
    apiSend("/api/admin/media/" + encodeURIComponent(card.dataset.mediaId), "PUT", getAdminMediaCardPayload(card))
      .then(function () { renderCurrentRoute(); })
      .catch(function (error) {
        if (button) button.disabled = false;
        window.alert(error.message || "媒体信息保存失败。");
      });
  }

  function deleteAdminMedia(card, button) {
    if (!card || !window.confirm("确认删除这张图片及全部缩略图吗？仍被文章引用时系统会阻止删除。")) return;
    if (button) button.disabled = true;
    apiSend("/api/admin/media/" + encodeURIComponent(card.dataset.mediaId), "DELETE")
      .then(function () { renderCurrentRoute(); })
      .catch(function (error) {
        if (button) button.disabled = false;
        window.alert(error.message || "图片删除失败。");
      });
  }

  function resetAdminArticleForm() {
    var form = document.getElementById("adminArticleForm");
    var title = document.getElementById("adminArticleFormTitle");

    if (!form) return;

    form.reset();
    if (form.elements.currentSlug) {
      form.elements.currentSlug.value = "";
    }
    if (form.elements.date) form.elements.date.value = new Date().toISOString().slice(0, 10);
    removeStoredValue("blog-admin-article-autosave");
    var preview = document.getElementById("adminArticlePreview");
    if (preview) preview.innerHTML = "<p>开始输入正文后，这里会显示预览。</p>";
    var versions = document.getElementById("adminArticleVersions");
    if (versions) versions.innerHTML = "<p>编辑现有文章后，可在这里查看并恢复历史版本。</p>";
    setAdminWorkspaceStatus("");
    if (title) {
      title.textContent = "新建文章";
    }
  }

  function resetAdminTrackForm() {
    var form = document.getElementById("adminTrackForm");
    var title = document.getElementById("adminTrackFormTitle");

    if (!form) return;

    form.reset();
    if (form.elements.currentId) {
      form.elements.currentId.value = "";
    }
    if (form.elements.bpm) {
      form.elements.bpm.value = "96";
    }
    if (title) {
      title.textContent = "新增音乐";
    }
  }

  function fillAdminArticleForm(article) {
    var form = document.getElementById("adminArticleForm");
    var title = document.getElementById("adminArticleFormTitle");

    if (!form || !article) return;

    form.elements.currentSlug.value = article.slug || "";
    form.elements.title.value = article.title || "";
    form.elements.slug.value = article.slug || "";
    form.elements.date.value = article.date && article.date.iso ? article.date.iso : "";
    form.elements.category.value = article.category || "";
    form.elements.tags.value = Array.isArray(article.tags) ? article.tags.join(", ") : "";
    form.elements.excerpt.value = article.excerpt || "";
    form.elements.content.value = article.source === undefined ? article.content || "" : article.source;
    if (form.elements.format) form.elements.format.value = article.format || "html";
    if (form.elements.status) form.elements.status.value = article.status || "published";
    if (form.elements.publishAt) form.elements.publishAt.value = toDateTimeLocalValue(article.publishAt);
    if (form.elements.coverMediaId) form.elements.coverMediaId.value = article.coverMediaId || "";

    if (title) {
      title.textContent = "编辑文章";
    }

    previewAdminArticle();
    loadAdminArticleVersions(article.slug);
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function fillAdminTrackForm(track) {
    var form = document.getElementById("adminTrackForm");
    var title = document.getElementById("adminTrackFormTitle");

    if (!form || !track) return;

    form.elements.currentId.value = track.id || "";
    form.elements.id.value = track.id || "";
    form.elements.title.value = track.title || "";
    form.elements.artist.value = track.artist || "";
    form.elements.subtitle.value = track.subtitle || "";
    form.elements.bpm.value = track.bpm || 96;
    form.elements.coverLabel.value = track.cover && track.cover.label ? track.cover.label : "";
    form.elements.coverFrom.value = track.cover && track.cover.from ? track.cover.from : "";
    form.elements.coverTo.value = track.cover && track.cover.to ? track.cover.to : "";
    form.elements.audioUrl.value = track.audioUrl || "";
    form.elements.notesJson.value = Array.isArray(track.notes) && track.notes.length ? JSON.stringify(track.notes, null, 2) : "";

    if (title) {
      title.textContent = "编辑音乐";
    }

    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function buildPageData() {
    var filters = state.route.filters;

    if (state.route.pageType === "admin") {
      return apiFetch("/api/admin/session").then(function (session) {
        var authenticated = Boolean(session && session.authenticated);
        state.adminAuthenticated = authenticated;
        state.adminSessionChecked = true;

        if (!authenticated) {
          return {
            adminSession: { authenticated: false },
            allArticles: [],
            adminCollections: { articles: [], playlist: [], media: [] },
          };
        }

        state.adminSessionMessage = "";
        return Promise.all([apiFetch("/api/admin/stats"), apiFetch("/api/admin/articles"), apiFetch("/api/playlist"), apiFetch("/api/admin/media")]).then(function (results) {
          return {
            adminSession: { authenticated: true },
            admin: results[0],
            allArticles: results[1].items,
            adminCollections: {
              articles: results[1].items,
              playlist: results[2].items || [],
              media: results[3].items || [],
            },
          };
        });
      });
    }

    var listFilters = Object.assign({}, filters);
    if (state.route.pageType === "archive" || state.route.pageType === "categories" || state.route.pageType === "tags") {
      listFilters.page = state.route.articlePage || 1;
      listFilters.limit = 6;
    }

    var listPromise = apiFetch("/api/articles" + serializeFilters(listFilters));
    var fullListPromise = apiFetch("/api/articles");
    var playlistPromise = apiFetch("/api/playlist").catch(function () { return { items: [] }; });

    if (state.route.pageType === "timeline") {
      return Promise.all([apiFetch("/api/timeline"), fullListPromise, playlistPromise]).then(function (results) {
        return {
          timeline: results[0].items,
          allArticles: results[1].items,
          adminCollections: {
            articles: results[1].items,
            playlist: results[2].items || [],
          },
        };
      });
    }

    if (state.route.pageType === "photos") {
      return Promise.all([apiFetch("/api/photos"), fullListPromise, playlistPromise]).then(function (results) {
        return {
          photos: results[0].items || [],
          allArticles: results[1].items,
          adminCollections: {
            articles: results[1].items,
            playlist: results[2].items || [],
          },
        };
      });
    }

    if (state.route.pageType === "community") {
      return Promise.all([
        apiFetch("/api/community?page=" + state.route.communityPage + "&limit=4"),
        fullListPromise,
        playlistPromise,
        apiFetch("/api/admin/session").catch(function () { return { authenticated: false }; }),
      ]).then(function (results) {
        return {
          community: results[0],
          allArticles: results[1].items,
          adminSession: results[3],
          adminCollections: {
            articles: results[1].items,
            playlist: results[2].items || [],
          },
        };
      });
    }

    if (state.route.pageType === "article") {
      return Promise.all([
        apiFetch("/api/articles/" + encodeURIComponent(state.route.articleSlug)),
        fullListPromise,
        playlistPromise,
      ])
        .then(function (results) {
          var article = results[0];
          var related = results[1].items
            .filter(function (item) {
              return item.slug !== article.slug;
            })
            .map(function (item) {
              var sharedTags = (item.tags || []).filter(function (tag) {
                return (article.tags || []).indexOf(tag) >= 0;
              }).length;
              var categoryScore = item.category === article.category ? 2 : 0;
              return { item: item, score: sharedTags * 3 + categoryScore };
            })
            .sort(function (left, right) {
              return right.score - left.score;
            })
            .map(function (entry) {
              return entry.item;
            })
            .slice(0, 3);

          return {
            article: article,
            related: related,
            allArticles: results[1].items,
            adminCollections: {
              articles: results[1].items,
              playlist: results[2].items || [],
            },
          };
        })
        .catch(function () {
          return fullListPromise.then(function (result) {
            return {
              article: null,
              related: [],
              allArticles: result.items,
            };
          });
        });
    }

    return Promise.all([listPromise, fullListPromise, apiFetch("/api/playlist")]).then(function (results) {
      return {
        articles: results[0].items,
        pagination: results[0].pagination,
        allArticles: results[1].items,
        adminCollections: {
          articles: results[1].items,
          playlist: results[2].items || [],
        },
      };
    });
  }

  function renderByRoute(pageData) {
    if (pageData.adminSession) {
      state.adminAuthenticated = Boolean(pageData.adminSession.authenticated);
      state.adminSessionChecked = true;
    }

    state.latestArticles = pageData.allArticles || pageData.articles || [];
    state.adminCollections = pageData.adminCollections || { articles: [], playlist: [], media: [] };
    if (state.adminCollections.playlist.length) {
      state.tracks = normalizeTracks(state.adminCollections.playlist);
    }

    var mainHtml = "";
    var pageType = state.route.pageType;

    if (pageType === "home") {
      mainHtml = renderHomeMain(pageData);
      setDocumentTitle(routeTitleMap.home);
    } else if (pageType === "archive") {
      mainHtml = renderArchiveMain(pageData);
      setDocumentTitle(routeTitleMap.archive);
    } else if (pageType === "categories") {
      mainHtml = renderCategoriesMain(pageData);
      setDocumentTitle(routeTitleMap.categories);
    } else if (pageType === "tags") {
      mainHtml = renderTagsMain(pageData);
      setDocumentTitle(routeTitleMap.tags);
    } else if (pageType === "timeline") {
      mainHtml = renderTimelineMain(pageData);
      setDocumentTitle(routeTitleMap.timeline);
    } else if (pageType === "about") {
      mainHtml = renderAboutMain();
      setDocumentTitle(routeTitleMap.about);
    } else if (pageType === "photos") {
      mainHtml = renderPhotosMain(pageData);
      setDocumentTitle(routeTitleMap.photos);
    } else if (pageType === "community") {
      mainHtml = renderCommunityMain(pageData);
      setDocumentTitle(routeTitleMap.community);
    } else if (pageType === "admin") {
      mainHtml = state.adminAuthenticated && pageData.admin ? renderAdminMain(pageData) : renderAdminLoginMain();
      setDocumentTitle(state.adminAuthenticated ? routeTitleMap.admin : "站长登录");
    } else if (pageType === "article" && pageData.article) {
      mainHtml = renderArticleMain(pageData);
      setDocumentTitle(pageData.article.title);
    } else {
      mainHtml = renderNotFoundMain();
      setDocumentTitle(routeTitleMap.notFound);
    }

    if (pageType === "archive" || pageType === "categories" || pageType === "tags") {
      mainHtml = mainHtml.replace("</main>", renderArticlePagination(pageData.pagination, state.route.path) + "</main>");
    }

    renderLayout(mainHtml);
    cachePlayerRefs();
    cacheCalendarRefs();
    cacheBackgroundRefs();
    renderPlaylist();
    syncPlayerUI();
    syncBackgroundAudioUI();
    renderCalendar();
    bindRenderedEvents();
    bindReadingProgress();
  }

  function bindReadingProgress() {
    var bar = document.getElementById("readingProgressBar");
    if (cleanupReadingProgress) {
      cleanupReadingProgress();
      cleanupReadingProgress = null;
    }

    if (!bar) {
      return;
    }

    var mainColumn = document.querySelector(".main-column");

    function getScrollMetrics() {
      var useMainColumn =
        mainColumn &&
        mainColumn.scrollHeight > mainColumn.clientHeight + 1 &&
        (window.getComputedStyle(mainColumn).overflowY === "auto" ||
          window.getComputedStyle(mainColumn).overflowY === "scroll");

      if (useMainColumn) {
        return {
          scrollTop: mainColumn.scrollTop,
          height: Math.max(1, mainColumn.scrollHeight - mainColumn.clientHeight),
        };
      }

      return {
        scrollTop: window.scrollY || document.documentElement.scrollTop || 0,
        height: Math.max(1, document.documentElement.scrollHeight - window.innerHeight),
      };
    }

    function update() {
      var metrics = getScrollMetrics();
      var percent = Math.min(100, Math.max(0, (metrics.scrollTop / metrics.height) * 100));
      bar.style.width = percent + "%";
    }

    if (mainColumn) {
      mainColumn.addEventListener("scroll", update, { passive: true });
    }
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    cleanupReadingProgress = function () {
      if (mainColumn) mainColumn.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
    update();
  }

  function bindRenderedEvents() {
    bindAdminArticleWorkspace();

    var notificationToggle = document.getElementById("notificationToggle");
    var notificationPanel = document.getElementById("notificationPanel");
    if (notificationToggle && notificationPanel) {
      notificationToggle.onclick = function () {
        notificationPanel.hidden = !notificationPanel.hidden;
        notificationToggle.setAttribute("aria-expanded", notificationPanel.hidden ? "false" : "true");
      };
    }

    if (playerRefs.playButton) {
      playerRefs.playButton.onclick = togglePlayerPlayback;
    }

    if (playerRefs.playModeButton) {
      playerRefs.playModeButton.onclick = cyclePlayMode;
    }

    if (playerRefs.miniPlayModeButton) {
      playerRefs.miniPlayModeButton.onclick = cyclePlayMode;
    }

    if (playerRefs.prevButton) {
      playerRefs.prevButton.onclick = function () {
        switchTrack(-1, true);
      };
    }

    if (playerRefs.miniPrevButton) {
      playerRefs.miniPrevButton.onclick = function () {
        switchTrack(-1, true);
      };
    }

    if (playerRefs.nextButton) {
      playerRefs.nextButton.onclick = function () {
        switchTrack(1, true);
      };
    }

    if (playerRefs.miniNextButton) {
      playerRefs.miniNextButton.onclick = function () {
        switchTrack(1, true);
      };
    }

    if (playerRefs.volumeRange) {
      playerRefs.volumeRange.oninput = function () {
        audio.volume = Number(playerRefs.volumeRange.value) / 100;
        if (audio.volume > 0) state.previousPlayerVolume = audio.volume;
        syncVolumeUI();
        savePlayerState();
      };
    }

    if (playerRefs.muteButton) {
      playerRefs.muteButton.onclick = function () {
        if (audio.volume > 0) {
          state.previousPlayerVolume = audio.volume;
          audio.volume = 0;
        } else {
          audio.volume = Math.max(0.05, state.previousPlayerVolume || 0.75);
        }
        syncVolumeUI();
        savePlayerState();
      };
    }

    if (playerRefs.progressRange) {
      playerRefs.progressRange.oninput = function () {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
        audio.currentTime = (Number(playerRefs.progressRange.value) / 100) * audio.duration;
        savePlayerState({ remote: false });
      };
      playerRefs.progressRange.onchange = function () {
        savePlayerState();
      };
    }

    if (playerRefs.miniPlayButton) {
      playerRefs.miniPlayButton.onclick = togglePlayerPlayback;
    }

    if (playerRefs.playlistToggle) {
      playerRefs.playlistToggle.onclick = function () {
        state.playlistOpen = !state.playlistOpen;
        syncPlayerUI();
        savePlayerState();
      };
    }

    if (playerRefs.playlistItems) {
      playerRefs.playlistItems.onclick = function (event) {
        var item = event.target.closest("li[data-index]");
        if (!item) return;
        var index = Number(item.getAttribute("data-index"));
        var track = state.tracks[index];
        if (track) state.unavailableTrackIds.delete(getTrackKey(track));
        loadTrack(index, true);
      };
    }

    if (backgroundRefs.toggle) {
      backgroundRefs.toggle.onclick = function () {
        toggleBackgroundAudio();
      };
    }

    if (calendarRefs.prev) {
      calendarRefs.prev.onclick = function () {
        state.calendarState.month -= 1;
        if (state.calendarState.month < 0) {
          state.calendarState.month = 11;
          state.calendarState.year -= 1;
        }
        renderCalendar();
      };
    }

    if (calendarRefs.next) {
      calendarRefs.next.onclick = function () {
        state.calendarState.month += 1;
        if (state.calendarState.month > 11) {
          state.calendarState.month = 0;
          state.calendarState.year += 1;
        }
        renderCalendar();
      };
    }

    if (calendarRefs.grid) {
      calendarRefs.grid.onclick = function (event) {
        var button = event.target.closest("button[data-date]");
        if (!button) return;

        var nextDate = button.getAttribute("data-date");
        var filters = {
          date: state.route.filters.date === nextDate ? "" : nextDate,
          category: "",
          tag: "",
          search: "",
        };

        navigate("/archive" + serializeFilters(filters));
      };
    }

    var searchForm = document.getElementById("searchForm");
    var searchInput = document.getElementById("searchInput");

    if (searchForm && searchInput) {
      searchForm.onsubmit = function (event) {
        event.preventDefault();
        var search = searchInput.value.trim();
        navigate("/archive" + serializeFilters({ search: search }));
      };
    }

    Array.prototype.forEach.call(document.querySelectorAll("form[data-form]"), function (form) {
      form.onsubmit = function (event) {
        event.preventDefault();

        var formData = new FormData(form);
        var payload = {
          name: String(formData.get("name") || "").trim(),
          avatar: String(formData.get("avatar") || "").trim(),
          content: String(formData.get("content") || "").trim(),
        };

        var submitButton = form.querySelector('button[type="submit"]');
        if (submitButton) submitButton.disabled = true;

        if (form.dataset.form === "admin-login") {
          var password = String(formData.get("password") || "");

          if (!password) {
            setFormStatus(form, "请输入站长密码。", "error");
            if (submitButton) submitButton.disabled = false;
            return;
          }

          setFormStatus(form, "正在验证身份，请稍候…");
          apiSend("/api/admin/session", "POST", { password: password })
            .then(function (result) {
              if (!result || !result.authenticated) {
                var loginError = new Error("密码验证失败，请重试。");
                loginError.status = 401;
                throw loginError;
              }

              state.adminAuthenticated = true;
              state.adminSessionChecked = true;
              state.adminSessionMessage = "";
              setFormStatus(form, "登录成功，正在进入后台…", "success");
              renderCurrentRoute();
            })
            .catch(function (error) {
              setFormStatus(form, error.message || "登录失败，请稍后重试。", "error");
              var passwordInput = form.elements.password;
              if (passwordInput) {
                passwordInput.select();
                passwordInput.focus();
              }
            })
            .finally(function () {
              if (submitButton) submitButton.disabled = false;
            });
          return;
        }

        if (form.dataset.form === "admin-settings") {
          payload = {
            title: String(formData.get("title") || "").trim(),
            name: String(formData.get("name") || "").trim(),
            tagline: String(formData.get("tagline") || "").trim(),
            announcement: String(formData.get("announcement") || "").trim(),
            bio: String(formData.get("bio") || "").trim(),
            about: String(formData.get("about") || "").trim(),
            avatar: String(formData.get("avatar") || "").trim(),
            copyright: String(formData.get("copyright") || "").trim(),
            github: String(formData.get("github") || "").trim(),
            weibo: String(formData.get("weibo") || "").trim(),
            douyin: String(formData.get("douyin") || "").trim(),
          };
          setFormStatus(form, "正在保存网站资料…");
          apiSend("/api/admin/settings", "PUT", payload)
            .then(function () {
              setFormStatus(form, "网站资料已更新。", "success");
              renderCurrentRoute();
            })
            .catch(function (error) {
              setFormStatus(form, error.message || "网站资料保存失败。", "error");
            })
            .finally(function () {
              if (submitButton) submitButton.disabled = false;
            });
          return;
        }

        if (form.dataset.form === "community-post") {
          setFormStatus(form, "正在发布帖子…");
          apiSend("/api/community/posts", "POST", payload)
            .then(function () {
              form.reset();
              state.route.communityPage = 1;
              setFormStatus(form, "帖子已发布。", "success");
              return refreshCommunityFeed(1);
            })
            .catch(function (error) {
              setFormStatus(form, error.message || "发布失败，请稍后重试。", "error");
            })
            .finally(function () {
              if (submitButton) submitButton.disabled = false;
            });
          return;
        }

        if (form.dataset.form === "community-comment") {
          setFormStatus(form, "正在发表评论…");
          apiSend("/api/community/posts/" + encodeURIComponent(form.dataset.postId) + "/comments", "POST", payload)
            .then(function () {
              form.reset();
              setFormStatus(form, "评论已发布。", "success");
              return refreshCommunityFeed(state.route.communityPage || 1);
            })
            .catch(function (error) {
              setFormStatus(form, error.message || "评论失败，请稍后重试。", "error");
            })
            .finally(function () {
              if (submitButton) submitButton.disabled = false;
            });
          return;
        }

        if (form.dataset.form === "article-comment") {
          if (form.dataset.parentId) {
            payload.parentId = form.dataset.parentId;
          }

          apiSend("/api/articles/" + encodeURIComponent(form.dataset.slug) + "/comments", "POST", payload)
            .then(function () {
              form.reset();
              refreshArticleComments(form.dataset.slug);
            })
            .catch(function (error) {
              window.alert(error.message);
            })
            .finally(function () {
              if (submitButton) submitButton.disabled = false;
            });
          return;
        }

        if (form.dataset.form === "admin-article") {
          payload = getAdminArticlePayload(form);
          if (payload.publishAt && !Number.isNaN(new Date(payload.publishAt).getTime())) {
            payload.publishAt = new Date(payload.publishAt).toISOString();
          }
          setAdminWorkspaceStatus("正在保存文章…");

          apiSend(
            form.elements.currentSlug && form.elements.currentSlug.value
              ? "/api/articles/" + encodeURIComponent(form.elements.currentSlug.value)
              : "/api/articles",
            form.elements.currentSlug && form.elements.currentSlug.value ? "PUT" : "POST",
            payload
          )
            .then(function () {
              setAdminWorkspaceStatus("文章已保存。", "success");
              resetAdminArticleForm();
              renderCurrentRoute();
            })
            .catch(function (error) {
              setAdminWorkspaceStatus(error.message || "文章保存失败。", "error");
            })
            .finally(function () {
              if (submitButton) submitButton.disabled = false;
            });
          return;
        }

        if (form.dataset.form === "admin-track") {
          payload = {
            id: String(formData.get("id") || "").trim(),
            title: String(formData.get("title") || "").trim(),
            artist: String(formData.get("artist") || "").trim(),
            subtitle: String(formData.get("subtitle") || "").trim(),
            bpm: Number(formData.get("bpm") || 96),
            coverLabel: String(formData.get("coverLabel") || "").trim(),
            coverFrom: String(formData.get("coverFrom") || "").trim(),
            coverTo: String(formData.get("coverTo") || "").trim(),
            audioUrl: String(formData.get("audioUrl") || "").trim(),
            notesJson: String(formData.get("notesJson") || "").trim(),
          };

          apiSend(
            form.elements.currentId && form.elements.currentId.value
              ? "/api/playlist/" + encodeURIComponent(form.elements.currentId.value)
              : "/api/playlist",
            form.elements.currentId && form.elements.currentId.value ? "PUT" : "POST",
            payload
          )
            .then(function () {
              resetAdminTrackForm();
              renderCurrentRoute();
            })
            .catch(function (error) {
              window.alert(error.message);
            })
            .finally(function () {
              if (submitButton) submitButton.disabled = false;
            });
        }
      };
    });

    document.querySelectorAll("[data-action]").forEach(function (element) {
      element.onclick = function () {
        var action = element.dataset.action;

        if (action === "open-photo") {
          openPhotoLightbox(Number(element.dataset.photoIndex || 0));
          return;
        }

        if (action === "close-photo") {
          closePhotoLightbox();
          return;
        }

        if (action === "prev-photo") {
          updatePhotoLightbox(state.activePhotoIndex - 1);
          return;
        }

        if (action === "next-photo") {
          updatePhotoLightbox(state.activePhotoIndex + 1);
          return;
        }

        if (action === "copy-code") {
          var codeBlock = element.closest(".code-block");
          var code = codeBlock ? codeBlock.querySelector("code, pre") : null;
          var text = code ? code.textContent : "";
          if (navigator.clipboard && text) {
            navigator.clipboard.writeText(text).then(function () {
              element.textContent = "已复制";
              setTimeout(function () {
                element.textContent = "复制";
              }, 1200);
            });
          }
          return;
        }

        if (action === "share-article") {
          var shareUrl = element.dataset.url || window.location.href;
          var shareTitle = element.dataset.title || document.title;
          if (navigator.share) {
            navigator.share({ title: shareTitle, url: shareUrl }).catch(function () {});
          } else if (navigator.clipboard) {
            navigator.clipboard.writeText(shareUrl).then(function () {
              window.alert("链接已复制");
            });
          }
          return;
        }

        if (action === "admin-logout") {
          element.disabled = true;
          apiSend("/api/admin/session", "DELETE")
            .then(function () {
              state.adminAuthenticated = false;
              state.adminSessionChecked = true;
              state.adminSessionMessage = "已安全退出后台。";
              renderCurrentRoute();
            })
            .catch(function (error) {
              if (error.status === 401) {
                state.adminAuthenticated = false;
                state.adminSessionChecked = true;
                state.adminSessionMessage = "登录状态已失效，请重新登录。";
                renderCurrentRoute();
                return;
              }

              element.disabled = false;
              window.alert(error.message);
            });
          return;
        }

        if (action === "community-page") {
          navigate("/community?page=" + Number(element.dataset.page || 1));
          return;
        }

        if (action === "focus-community-comment") {
          var targetInput = document.getElementById("community-comment-" + element.dataset.postId);
          if (targetInput) {
            targetInput.focus();
            targetInput.scrollIntoView({ behavior: "smooth", block: "center" });
          }
          return;
        }

        if (action === "toggle-reply-form") {
          var target = document.getElementById(element.dataset.target);
          if (target) {
            target.hidden = !target.hidden;
            if (!target.hidden) {
              var area = target.querySelector("textarea");
              if (area) area.focus();
            }
          }
          return;
        }

        if (action === "like-community-post") {
          apiSend("/api/community/posts/" + encodeURIComponent(element.dataset.postId) + "/like", "POST")
            .then(function () {
              refreshCommunityFeed(state.route.communityPage || 1);
            })
            .catch(function (error) {
              window.alert(error.message);
            });
          return;
        }

        if (action === "delete-community-post") {
          if (!state.adminAuthenticated) {
            return;
          }

          if (!window.confirm("确认删除这条帖子吗？删除后不可恢复。")) {
            return;
          }

          apiSend("/api/community/posts/" + encodeURIComponent(element.dataset.postId), "DELETE")
            .then(function () {
              refreshCommunityFeed(state.route.communityPage || 1);
            })
            .catch(function (error) {
              window.alert(error.message);
            });
          return;
        }

        if (action === "like-community-comment") {
          apiSend(
            "/api/community/posts/" +
              encodeURIComponent(element.dataset.postId) +
              "/comments/" +
              encodeURIComponent(element.dataset.commentId) +
              "/like",
            "POST"
          )
            .then(function () {
              refreshCommunityFeed(state.route.communityPage || 1);
            })
            .catch(function (error) {
              window.alert(error.message);
            });
          return;
        }

        if (action === "delete-community-comment") {
          if (!state.adminAuthenticated) {
            return;
          }

          if (!window.confirm("确认删除这条评论吗？删除后不可恢复。")) {
            return;
          }

          apiSend(
            "/api/community/posts/" +
              encodeURIComponent(element.dataset.postId) +
              "/comments/" +
              encodeURIComponent(element.dataset.commentId),
            "DELETE"
          )
            .then(function () {
              refreshCommunityFeed(state.route.communityPage || 1);
            })
            .catch(function (error) {
              window.alert(error.message);
            });
          return;
        }

        if (action === "like-article") {
          apiSend("/api/articles/" + encodeURIComponent(element.dataset.slug) + "/like", "POST")
            .then(function () {
              renderCurrentRoute();
            })
            .catch(function (error) {
              window.alert(error.message);
            });
          return;
        }

        if (action === "reset-admin-article") {
          resetAdminArticleForm();
          return;
        }

        if (action === "preview-admin-article") {
          previewAdminArticle();
          return;
        }

        if (action === "restore-admin-autosave") {
          restoreAdminArticleAutosave();
          element.hidden = true;
          return;
        }

        if (action === "upload-admin-image") {
          uploadAdminArticleImage(element);
          return;
        }

        if (action === "upload-admin-media") {
          uploadAdminMedia(element);
          return;
        }

        if (action === "save-admin-media") {
          saveAdminMedia(element.closest(".admin-media-card"), element);
          return;
        }

        if (action === "delete-admin-media") {
          deleteAdminMedia(element.closest(".admin-media-card"), element);
          return;
        }

        if (action === "reset-admin-track") {
          resetAdminTrackForm();
          return;
        }

        if (action === "edit-admin-article" || action === "versions-admin-article") {
          var articleMatch = (state.adminCollections.articles || []).find(function (item) {
            return item.slug === element.dataset.slug;
          });
          fillAdminArticleForm(articleMatch);
          return;
        }

        if (action === "delete-admin-article") {
          if (!window.confirm("确认删除这篇文章吗？文章评论也会一起删除。")) {
            return;
          }

          apiSend("/api/articles/" + encodeURIComponent(element.dataset.slug), "DELETE")
            .then(function () {
              resetAdminArticleForm();
              renderCurrentRoute();
            })
            .catch(function (error) {
              window.alert(error.message);
            });
          return;
        }

        if (action === "edit-admin-track") {
          var trackMatch = (state.adminCollections.playlist || []).find(function (item) {
            return item.id === element.dataset.id;
          });
          fillAdminTrackForm(trackMatch);
          return;
        }

        if (action === "delete-admin-track") {
          if (!window.confirm("确认删除这首音乐吗？删除后播放器列表会立即更新。")) {
            return;
          }

          apiSend("/api/playlist/" + encodeURIComponent(element.dataset.id), "DELETE")
            .then(function () {
              resetAdminTrackForm();
              renderCurrentRoute();
            })
            .catch(function (error) {
              window.alert(error.message);
            });
          return;
        }

        if (action === "like-article-comment") {
          apiSend(
            "/api/articles/" +
              encodeURIComponent(element.dataset.slug) +
              "/comments/" +
              encodeURIComponent(element.dataset.commentId) +
              "/like",
            "POST"
          )
            .then(function () {
              refreshArticleComments(element.dataset.slug);
            })
            .catch(function (error) {
              window.alert(error.message);
            });
          return;
        }

        if (action === "delete-article-comment") {
          if (!window.confirm("确认删除这条评论及其回复吗？删除后不可恢复。")) {
            return;
          }

          apiSend(
            "/api/articles/" +
              encodeURIComponent(element.dataset.slug) +
              "/comments/" +
              encodeURIComponent(element.dataset.commentId),
            "DELETE"
          )
            .then(function () {
              refreshArticleComments(element.dataset.slug);
            })
            .catch(function (error) {
              window.alert(error.message);
            });
          return;
        }

        if (action === "like-article-reply") {
          apiSend(
            "/api/articles/" +
              encodeURIComponent(element.dataset.slug) +
              "/comments/" +
              encodeURIComponent(element.dataset.commentId) +
              "/replies/" +
              encodeURIComponent(element.dataset.replyId) +
              "/like",
            "POST"
          )
            .then(function () {
              refreshArticleComments(element.dataset.slug);
            })
            .catch(function (error) {
              window.alert(error.message);
            });
          return;
        }

        if (action === "delete-article-reply") {
          if (!window.confirm("确认删除这条回复吗？删除后不可恢复。")) {
            return;
          }

          apiSend(
            "/api/articles/" +
              encodeURIComponent(element.dataset.slug) +
              "/comments/" +
              encodeURIComponent(element.dataset.commentId) +
              "/replies/" +
              encodeURIComponent(element.dataset.replyId),
            "DELETE"
          )
            .then(function () {
              refreshArticleComments(element.dataset.slug);
            })
            .catch(function (error) {
              window.alert(error.message);
            });
        }

        if (action === "import-netease-track") {
          var songData = {
            id: element.dataset.id,
            title: element.dataset.title,
            artist: element.dataset.artist,
            subtitle: element.dataset.subtitle || element.dataset.artist || "",
            coverUrl: element.dataset.cover || "",
            audioUrl: element.dataset.audio || "",
            bpm: 96,
          };

          apiSend("/api/playlist", "POST", songData)
            .then(function () {
              renderCurrentRoute();
            })
            .catch(function (error) {
              window.alert(error.message);
            });
          return;
        }
      };
    });

    var neteaseSearchBtn = document.getElementById("neteaseSearchBtn");
    var neteaseSearchInput = document.getElementById("neteaseSearchInput");
    var neteaseResults = document.getElementById("neteaseResults");

    function doNeteaseSearch() {
      if (!neteaseSearchInput || !neteaseResults) return;

      var keyword = neteaseSearchInput.value.trim();
      if (!keyword) return;

      neteaseResults.innerHTML = '<div class="empty-state empty-state--compact">搜索中...</div>';

      apiFetch("/api/netease/search?keyword=" + encodeURIComponent(keyword) + "&limit=10")
        .then(function (result) {
          if (!result.items || !result.items.length) {
            neteaseResults.innerHTML = '<div class="empty-state empty-state--compact">未找到相关歌曲，试试其他关键词。</div>';
            return;
          }

          neteaseResults.innerHTML = result.items
            .map(function (song) {
              var coverSrc = song.coverUrl
                ? "/api/netease/cover?url=" + encodeURIComponent(song.coverUrl)
                : "";
              return (
                '<article class="netease-result">' +
                '<img class="netease-result__cover" src="' +
                escapeHtml(coverSrc) +
                '" alt="' +
                escapeHtml(song.name) +
                '" loading="lazy" onerror="this.style.display=\'none\'" />' +
                '<div class="netease-result__info">' +
                "<strong>" +
                escapeHtml(song.name) +
                "</strong>" +
                "<span>" +
                escapeHtml(song.artist) +
                "</span>" +
                '<span class="netease-result__album">' +
                escapeHtml(song.album) +
                " · " +
                escapeHtml(song.durationText || "") +
                "</span>" +
                "</div>" +
                '<button type="button" class="button-primary button-sm" ' +
                'data-action="import-netease-track" ' +
                'data-id="netease-' +
                escapeHtml(song.id) +
                '" ' +
                'data-title="' +
                escapeHtml(song.name) +
                '" ' +
                'data-artist="' +
                escapeHtml(song.artist) +
                '" ' +
                'data-subtitle="' +
                escapeHtml(song.artist + " · " + song.album) +
                '" ' +
                'data-cover="' +
                escapeHtml(coverSrc) +
                '" ' +
                'data-audio="/api/netease/audio/' +
                escapeHtml(song.id) +
                '">' +
                '<i class="fa-solid fa-download"></i> 导入' +
                "</button>" +
                "</article>"
              );
            })
            .join("");

          Array.prototype.forEach.call(neteaseResults.querySelectorAll("[data-action='import-netease-track']"), function (btn) {
            btn.onclick = function () {
              var action = btn.dataset.action;
              if (action === "import-netease-track") {
                var songData = {
                  id: btn.dataset.id,
                  title: btn.dataset.title,
                  artist: btn.dataset.artist,
                  subtitle: btn.dataset.subtitle,
                  coverUrl: btn.dataset.cover,
                  audioUrl: btn.dataset.audio,
                  bpm: 96,
                };

                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 导入中';

                apiSend("/api/playlist", "POST", songData)
                  .then(function () {
                    btn.innerHTML = '<i class="fa-solid fa-check"></i> 已导入';
                    btn.classList.remove("button-primary");
                    btn.classList.add("button-secondary");
                  })
                  .catch(function (error) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-download"></i> 导入';
                    window.alert(error.message);
                  });
              }
            };
          });
        })
        .catch(function (error) {
          neteaseResults.innerHTML = '<div class="empty-state empty-state--compact">搜索失败：' + escapeHtml(error.message) + "</div>";
        });
    }

    if (neteaseSearchBtn) {
      neteaseSearchBtn.onclick = doNeteaseSearch;
    }

    if (neteaseSearchInput) {
      neteaseSearchInput.onkeydown = function (event) {
        if (event.key === "Enter") {
          doNeteaseSearch();
        }
      };
    }
  }

  function shouldHandleLink(anchor) {
    if (!anchor) return false;
    if (anchor.target === "_blank" || anchor.hasAttribute("download")) return false;

    var href = anchor.getAttribute("href");
    if (!href || href.indexOf("http") === 0 || href.indexOf("mailto:") === 0) return false;
    return href.indexOf("/") === 0;
  }

  function navigate(url, replace) {
    savePlayerState({ remote: false });

    if (replace) {
      window.history.replaceState({}, "", url);
    } else {
      window.history.pushState({}, "", url);
    }

    state.route = parseLocation();
    applyRouteCalendarState(state.route);
    renderCurrentRoute();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderCurrentRoute() {
    buildPageData()
      .then(function (pageData) {
        return apiFetch("/api/site").then(function (siteBundle) {
          state.siteBundle = siteBundle;
          renderByRoute(pageData);
        });
      })
      .catch(function (error) {
        if (state.route.pageType === "admin" && error.status === 401 && state.siteBundle) {
          state.adminAuthenticated = false;
          state.adminSessionChecked = true;
          state.adminSessionMessage = "登录状态已失效，请重新登录。";
          renderByRoute({
            adminSession: { authenticated: false },
            allArticles: [],
            adminCollections: { articles: [], playlist: [], media: [] },
          });
          return;
        }

        appRoot.innerHTML =
          '<div class="prototype-shell"><main class="main-column"><section class="glass-panel page-panel"><div class="empty-state">页面加载失败：' +
          escapeHtml(error.message) +
          "</div></section></main></div>";
      });
  }

  function bindGlobalNavigation() {
    document.addEventListener("click", function (event) {
      var anchor = event.target.closest("a");
      if (!shouldHandleLink(anchor)) return;

      event.preventDefault();
      navigate(anchor.getAttribute("href"));
    });

    window.addEventListener("popstate", function () {
      state.route = parseLocation();
      applyRouteCalendarState(state.route);
      renderCurrentRoute();
    });

    document.addEventListener("keydown", function (event) {
      var lightbox = document.getElementById("photoLightbox");
      if (!lightbox || lightbox.hidden) return;
      if (event.key === "Escape") closePhotoLightbox();
      if (event.key === "ArrowLeft") updatePhotoLightbox(state.activePhotoIndex - 1);
      if (event.key === "ArrowRight") updatePhotoLightbox(state.activePhotoIndex + 1);
    });
  }

  function init() {
    applyRouteCalendarState(state.route);

    var initialPlaylistPromise = state.route.pageType === "admin"
      ? Promise.resolve({ items: [] })
      : apiFetch("/api/playlist");

    Promise.all([
      apiFetch("/api/site"),
      initialPlaylistPromise,
      apiFetch("/api/player/state"),
      apiFetch("/api/admin/session").catch(function () { return { authenticated: false }; }),
    ])
      .then(function (results) {
        state.siteBundle = results[0];
        state.tracks = normalizeTracks(results[1].items || []);
        state.adminAuthenticated = Boolean(results[3] && results[3].authenticated);
        state.adminSessionChecked = true;
        audio.volume = 0.75;
        bindPlayerEvents();
        bindBackgroundEvents();
        bindGlobalNavigation();
        restorePlayerState(results[2] && results[2].item);
        if (state.backgroundAudioEnabled) {
          tryEnableBackgroundAudio();
        }
        renderCurrentRoute();
      })
      .catch(function (error) {
        appRoot.innerHTML =
          '<div class="prototype-shell"><main class="main-column"><section class="glass-panel page-panel"><div class="empty-state">初始化失败：' +
          escapeHtml(error.message) +
          "</div></section></main></div>";
      });
  }

  init();
})();
