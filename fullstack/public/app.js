(function () {
  var appRoot = document.getElementById("app");
  var audio = document.getElementById("audioPlayer");

  if (!appRoot) {
    return;
  }

  if (!audio) {
    audio = document.createElement("audio");
    audio.id = "audioPlayer";
    audio.preload = "metadata";
    document.body.appendChild(audio);
  }

  var weekNames = ["日", "一", "二", "三", "四", "五", "六"];
  var routeTitleMap = {
    home: "首页",
    archive: "归档",
    categories: "分类",
    tags: "标签",
    timeline: "时光机",
    about: "关于我",
    article: "文章详情",
  };

  var state = {
    siteBundle: null,
    tracks: [],
    activeTrackIndex: 0,
    playlistOpen: true,
    calendarState: {
      year: new Date().getFullYear(),
      month: new Date().getMonth(),
    },
    route: parseLocation(),
  };

  var playerRefs = {};
  var calendarRefs = {};
  var playerEventsBound = false;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function apiFetch(url) {
    return fetch(url).then(function (response) {
      if (!response.ok) {
        throw new Error("Request failed: " + response.status);
      }

      return response.json();
    });
  }

  function parseLocation() {
    var pathname = window.location.pathname;
    var params = new URLSearchParams(window.location.search);
    var route = {
      path: pathname,
      pageType: "home",
      articleSlug: null,
      filters: {
        date: params.get("date") || "",
        category: params.get("category") || "",
        tag: params.get("tag") || "",
        search: params.get("search") || "",
      },
    };

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
    } else if (pathname.indexOf("/articles/") === 0) {
      route.pageType = "article";
      route.articleSlug = decodeURIComponent(pathname.replace("/articles/", ""));
    }

    if (route.filters.date) {
      var selected = new Date(route.filters.date);
      if (!Number.isNaN(selected.getTime())) {
        state.calendarState.year = selected.getFullYear();
        state.calendarState.month = selected.getMonth();
      }
    }

    return route;
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
    return items.map(function (item) {
      return {
        id: item.id,
        title: item.title,
        artist: item.artist,
        subtitle: item.subtitle,
        cover: createCover(item.cover.label, item.cover.from, item.cover.to),
        src: createMelodyTrack(item.notes, { bpm: item.bpm }),
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

  function renderPostItem(article) {
    return (
      '<article class="post-item">' +
      '<div class="post-item__content">' +
      "<h3>" +
      escapeHtml(article.title) +
      "</h3>" +
      '<div class="article-meta">' +
      "<span><i class=\"fa-regular fa-user\"></i> Allen</span>" +
      "<span><i class=\"fa-regular fa-calendar\"></i> " +
      escapeHtml(article.date.display || formatDateLabel(article.date.iso)) +
      "</span>" +
      "<span><i class=\"fa-regular fa-folder-open\"></i> " +
      escapeHtml(article.category) +
      "</span>" +
      "</div>" +
      "<p>" +
      escapeHtml(article.excerpt) +
      "</p>" +
      '<a class="article-link" href="/articles/' +
      encodeURIComponent(article.slug) +
      '">阅读全文</a>' +
      "</div>" +
      renderVideoCard("post-thumb") +
      "</article>"
    );
  }

  function renderPlayerCard() {
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
      '<div class="player-lyrics" id="songSubtitle">未闻花名的晚风，吹向银河彼岸。</div>' +
      '<div class="player-progress">' +
      '<span id="currentTime">00:00</span>' +
      '<input id="progressRange" type="range" min="0" max="100" value="0" />' +
      '<span id="durationTime">00:00</span>' +
      "</div>" +
      '<div class="player-controls">' +
      '<button type="button" id="prevButton" aria-label="上一曲"><i class="fa-solid fa-backward-step"></i></button>' +
      '<button type="button" id="playButton" class="play-button" aria-label="播放或暂停"><i class="fa-solid fa-play"></i></button>' +
      '<button type="button" id="nextButton" aria-label="下一曲"><i class="fa-solid fa-forward-step"></i></button>' +
      '<label class="volume-box" aria-label="音量控制">' +
      '<i class="fa-solid fa-volume-high"></i>' +
      '<input id="volumeRange" type="range" min="0" max="100" value="75" />' +
      "</label>" +
      "</div>" +
      "</div>" +
      '<aside class="player-playlist" id="playlistPanel">' +
      '<div class="player-playlist__title">播放列表</div>' +
      '<ul id="playlistItems"></ul>' +
      "</aside>" +
      "</section>"
    );
  }

  function renderSiteInfo(stats) {
    return (
      '<section class="glass-panel stat-panel">' +
      '<div class="panel-title"><i class="fa-solid fa-chart-column"></i><span>网站信息</span></div>' +
      '<div class="site-stat-list">' +
      "<div><span>文章数目</span><strong>" +
      stats.articleCount +
      "</strong></div>" +
      "<div><span>本站总浏览量</span><strong>" +
      stats.viewCount +
      "</strong></div>" +
      "<div><span>本站访客数</span><strong>" +
      stats.visitorCount +
      "</strong></div>" +
      "<div><span>最后更新时间</span><strong>" +
      escapeHtml(stats.updatedLabel) +
      "</strong></div>" +
      "</div>" +
      "</section>"
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
      renderPlayerCard() +
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
      renderPlayerCard() +
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
      renderPlayerCard() +
      "</main>"
    );
  }

  function renderTimelineMain(pageData) {
    return (
      '<main class="main-column">' +
      '<section class="glass-panel page-panel">' +
      '<div class="page-heading"><div><h2>时光机</h2><p>按时间线回看保存下来的灵感与记录。</p></div></div>' +
      '<div class="timeline-stack">' +
      (pageData.timeline.length
        ? pageData.timeline
            .map(function (group) {
              return (
                '<section class="timeline-group">' +
                "<h3>" +
                escapeHtml(group.label) +
                "</h3>" +
                '<div class="timeline-group__items">' +
                group.items
                  .map(function (item) {
                    return (
                      '<article class="timeline-entry">' +
                      '<div class="micro-meta"><span>' +
                      escapeHtml(item.date) +
                      "</span><span>" +
                      escapeHtml(item.category) +
                      "</span></div>" +
                      "<h3>" +
                      escapeHtml(item.title) +
                      "</h3>" +
                      "<p>" +
                      escapeHtml(item.excerpt) +
                      '</p><a class="article-link" href="/articles/' +
                      encodeURIComponent(item.slug) +
                      '">阅读文章</a>' +
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
      renderPlayerCard() +
      "</main>"
    );
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
      '<div class="rich-content"><p>' +
      escapeHtml(profile.about) +
      "</p><p>这个页面保留了原型里的动态背景、蓝紫玻璃质感、侧边导航和音乐播放器，同时增加了后端接口、动态文章数据、日历筛选和完整路由。</p></div>" +
      "</section>" +
      renderPlayerCard() +
      "</main>"
    );
  }

  function renderArticleMain(pageData) {
    if (!pageData.article) {
      return (
        '<main class="main-column"><section class="glass-panel page-panel"><div class="empty-state">文章不存在或已被移除。</div></section>' +
        renderPlayerCard() +
        "</main>"
      );
    }

    var article = pageData.article;
    var related = pageData.related;

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
      "</div>" +
      '<div class="meta-pills">' +
      article.tags
        .map(function (tag) {
          return '<a href="/tags' + serializeFilters({ tag: tag }) + '">#' + escapeHtml(tag) + "</a>";
        })
        .join("") +
      "</div>" +
      "</div>" +
      renderVideoCard("detail-media") +
      '<div class="rich-content">' +
      article.content +
      "</div>" +
      "</section>" +
      '<section class="glass-panel page-panel detail-related">' +
      "<h3>相关文章</h3>" +
      (related.length
        ? related.map(renderPostItem).join("")
        : '<div class="empty-state">暂无相关文章。</div>') +
      "</section>" +
      renderPlayerCard() +
      "</main>"
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
      "</nav>" +
      '<div class="side-nav__footer"><div class="side-nav__label">联系我</div>' +
      '<div class="social-dock">' +
      state.siteBundle.profile.socials
        .map(function (social) {
          return (
            '<a href="' +
            social.url +
            '" target="_blank" rel="noreferrer" aria-label="' +
            escapeHtml(social.label) +
            '"><i class="' +
            social.icon +
            '"></i></a>'
          );
        })
        .join("") +
      "</div>" +
      '<p class="side-nav__copyright"><span>© 2026 朝花夕拾。</span><span>All rights reserved.</span></p>' +
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
      '<button class="icon-button" type="button" aria-label="通知"><i class="fa-regular fa-bell"></i></button>' +
      '<button class="icon-button" type="button" aria-label="设置"><i class="fa-solid fa-gear"></i></button>' +
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
    appRoot.innerHTML = '<div class="prototype-shell">' + renderSidebar() + renderTopbar() + mainHtml + renderRightColumn() + "</div>";
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
      playButton: document.getElementById("playButton"),
      prevButton: document.getElementById("prevButton"),
      nextButton: document.getElementById("nextButton"),
      playlistToggle: document.getElementById("playlistToggle"),
      playlistPanel: document.getElementById("playlistPanel"),
      playlistItems: document.getElementById("playlistItems"),
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

  function updatePlayButton(isPlaying) {
    if (!playerRefs.playButton || !playerRefs.playerCard) return;

    playerRefs.playButton.innerHTML = isPlaying
      ? '<i class="fa-solid fa-pause"></i>'
      : '<i class="fa-solid fa-play"></i>';
    playerRefs.playerCard.classList.toggle("is-playing", isPlaying);
  }

  function syncPlaylistState() {
    if (!playerRefs.playlistItems) return;

    Array.prototype.forEach.call(playerRefs.playlistItems.querySelectorAll("li"), function (item, index) {
      item.classList.toggle("is-active", index === state.activeTrackIndex);
    });
  }

  function syncPlayerUI() {
    if (!state.tracks.length || !playerRefs.songTitle) return;

    var track = state.tracks[state.activeTrackIndex];
    playerRefs.songTitle.textContent = track.title;
    playerRefs.songArtist.textContent = track.artist;
    playerRefs.songSubtitle.textContent = track.subtitle;
    playerRefs.coverImage.src = track.cover;
    playerRefs.coverImage.alt = track.title + " 专辑封面";
    playerRefs.playlistPanel.hidden = !state.playlistOpen;
    playerRefs.volumeRange.value = String(Math.round(audio.volume * 100));
    playerRefs.currentTime.textContent = formatTime(audio.currentTime);
    playerRefs.durationTime.textContent = formatTime(audio.duration);
    playerRefs.progressRange.value = audio.duration ? String((audio.currentTime / audio.duration) * 100) : "0";
    updatePlayButton(!audio.paused);
    syncPlaylistState();
  }

  function renderPlaylist() {
    if (!playerRefs.playlistItems) return;

    playerRefs.playlistItems.innerHTML = state.tracks
      .map(function (track, index) {
        return (
          '<li data-index="' +
          index +
          '"><strong>' +
          escapeHtml(track.title) +
          "</strong><span>" +
          escapeHtml(track.artist) +
          "</span></li>"
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

    audio.src = track.src;
    audio.load();
    syncPlayerUI();

    if (shouldPlay || (!wasPaused && shouldPlay !== false)) {
      audio.play().catch(function () {
        updatePlayButton(false);
      });
    } else {
      updatePlayButton(false);
    }
  }

  function bindPlayerEvents() {
    if (playerEventsBound) return;
    playerEventsBound = true;

    audio.addEventListener("loadedmetadata", function () {
      if (playerRefs.durationTime) {
        playerRefs.durationTime.textContent = formatTime(audio.duration);
      }
    });

    audio.addEventListener("timeupdate", function () {
      if (!playerRefs.currentTime) return;
      playerRefs.currentTime.textContent = formatTime(audio.currentTime);
      if (playerRefs.progressRange && audio.duration) {
        playerRefs.progressRange.value = (audio.currentTime / audio.duration) * 100;
      }
    });

    audio.addEventListener("play", function () {
      updatePlayButton(true);
    });

    audio.addEventListener("pause", function () {
      updatePlayButton(false);
    });

    audio.addEventListener("ended", function () {
      loadTrack(state.activeTrackIndex + 1, true);
    });
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

  function buildPageData() {
    var filters = state.route.filters;
    var listPromise = apiFetch("/api/articles" + serializeFilters(filters));
    var fullListPromise = apiFetch("/api/articles");

    if (state.route.pageType === "timeline") {
      return Promise.all([apiFetch("/api/timeline"), fullListPromise]).then(function (results) {
        return {
          timeline: results[0].items,
          allArticles: results[1].items,
        };
      });
    }

    if (state.route.pageType === "article") {
      return Promise.all([apiFetch("/api/articles/" + encodeURIComponent(state.route.articleSlug)), fullListPromise])
        .then(function (results) {
          var article = results[0];
          var related = results[1].items
            .filter(function (item) {
              return item.slug !== article.slug;
            })
            .slice(0, 3);

          return {
            article: article,
            related: related,
            allArticles: results[1].items,
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

    return Promise.all([listPromise, fullListPromise]).then(function (results) {
      return {
        articles: results[0].items,
        allArticles: results[1].items,
      };
    });
  }

  function renderByRoute(pageData) {
    state.latestArticles = pageData.allArticles || pageData.articles || [];

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
    } else {
      mainHtml = renderArticleMain(pageData);
      setDocumentTitle(pageData.article ? pageData.article.title : routeTitleMap.article);
    }

    renderLayout(mainHtml);
    cachePlayerRefs();
    cacheCalendarRefs();
    renderPlaylist();
    syncPlayerUI();
    renderCalendar();
    bindRenderedEvents();
  }

  function bindRenderedEvents() {
    if (playerRefs.playButton) {
      playerRefs.playButton.onclick = function () {
        if (audio.paused) {
          audio.play().catch(function () {
            updatePlayButton(false);
          });
        } else {
          audio.pause();
        }
      };
    }

    if (playerRefs.prevButton) {
      playerRefs.prevButton.onclick = function () {
        loadTrack(state.activeTrackIndex - 1, true);
      };
    }

    if (playerRefs.nextButton) {
      playerRefs.nextButton.onclick = function () {
        loadTrack(state.activeTrackIndex + 1, true);
      };
    }

    if (playerRefs.volumeRange) {
      playerRefs.volumeRange.oninput = function () {
        audio.volume = Number(playerRefs.volumeRange.value) / 100;
      };
    }

    if (playerRefs.progressRange) {
      playerRefs.progressRange.oninput = function () {
        if (!audio.duration) return;
        audio.currentTime = (Number(playerRefs.progressRange.value) / 100) * audio.duration;
      };
    }

    if (playerRefs.playlistToggle) {
      playerRefs.playlistToggle.onclick = function () {
        state.playlistOpen = !state.playlistOpen;
        syncPlayerUI();
      };
    }

    if (playerRefs.playlistItems) {
      playerRefs.playlistItems.onclick = function (event) {
        var item = event.target.closest("li[data-index]");
        if (!item) return;
        loadTrack(Number(item.getAttribute("data-index")), true);
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
  }

  function shouldHandleLink(anchor) {
    if (!anchor) return false;
    if (anchor.target === "_blank" || anchor.hasAttribute("download")) return false;

    var href = anchor.getAttribute("href");
    if (!href || href.indexOf("http") === 0 || href.indexOf("mailto:") === 0) return false;
    return href.indexOf("/") === 0;
  }

  function navigate(url, replace) {
    if (replace) {
      window.history.replaceState({}, "", url);
    } else {
      window.history.pushState({}, "", url);
    }

    state.route = parseLocation();
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
      renderCurrentRoute();
    });
  }

  function init() {
    Promise.all([apiFetch("/api/site"), apiFetch("/api/playlist")])
      .then(function (results) {
        state.siteBundle = results[0];
        state.tracks = normalizeTracks(results[1].items);
        audio.volume = 0.75;
        bindPlayerEvents();
        bindGlobalNavigation();
        loadTrack(0, false);
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
