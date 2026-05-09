(function () {
  var state = {
    user: null,
    posts: [],
    users: [],
    stats: [],
    activeTab: "posts",
    editingPostId: null,
    currentComments: [],
    currentCommentPostId: "",
  };

  function $(selector) { return document.querySelector(selector); }
  function $all(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function request(url, options) {
    return fetch(url, options || {}).then(function (res) {
      if (res.status === 204) {
        return {};
      }

      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error(data.message || ("请求失败: " + res.status));
        }
        return data;
      });
    });
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    $all(".admin-nav__item").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.dataset.tab === tab);
    });
    $all(".admin-tab").forEach(function (panel) {
      panel.classList.toggle("is-active", panel.id === "tab-" + tab);
    });

    var map = {
      posts: { title: "文章管理", desc: "支持直接写文章、上传 Markdown / Word、实时预览与评论管理。" },
      users: { title: "用户管理", desc: "查看 QQ 登录用户、头像、昵称和权限。" },
      stats: { title: "统计管理", desc: "按日、周、月查看统计，支持导出报表和重置统计。" },
    };

    $("#pageTitle").textContent = map[tab].title;
    $("#pageDesc").textContent = map[tab].desc;
  }

  function renderUserBox() {
    var box = $("#adminUserBox");

    if (!state.user) {
      var buttons =
        '<div class="login-actions">' +
          '<a class="btn btn-primary btn-block" href="/api/auth/qq/login">QQ 登录</a>' +
          (window.location.hostname === "localhost"
            ? '<button id="devLoginBtn" class="btn btn-secondary btn-block">本地开发登录</button>'
            : "") +
        '</div>';
      box.innerHTML = buttons;

      var devLoginBtn = $("#devLoginBtn");
      if (devLoginBtn) {
        devLoginBtn.onclick = function () {
          request("/api/auth/dev-login", { method: "POST" }).then(function () {
            window.location.reload();
          }).catch(function (error) {
            alert(error.message);
          });
        };
      }
      return;
    }

    box.innerHTML =
      '<div class="admin-usercard">' +
        '<img src="' + escapeHtml(state.user.avatar_url || "/images/avatar.jpg") + '" alt="头像" />' +
        '<div>' +
          '<strong>' + escapeHtml(state.user.username || "未命名用户") + '</strong>' +
          '<div class="muted">角色：' + escapeHtml(state.user.role || "user") + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:12px;">' +
        '<button id="logoutBtn" class="btn btn-secondary btn-block">退出登录</button>' +
      '</div>';

    $("#logoutBtn").onclick = function () {
      request("/api/auth/logout", { method: "POST" }).then(function () {
        window.location.reload();
      });
    };
  }

  function renderPostPreview() {
    var content = $("#postContentInput").value || "";
    $("#postPreview").innerHTML = window.marked ? marked.parse(content) : escapeHtml(content);
  }

  function fillCategoryFilter() {
    var categories = [];
    var seen = {};

    state.posts.forEach(function (item) {
      if (item.category_name && !seen[item.category_name]) {
        seen[item.category_name] = true;
        categories.push(item.category_name);
      }
    });

    $("#postCategoryFilter").innerHTML =
      '<option value="">全部分类</option>' +
      categories.map(function (name) {
        return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
      }).join("");

    $("#commentPostFilter").innerHTML =
      '<option value="">选择文章查看评论</option>' +
      state.posts.map(function (item) {
        return '<option value="' + item.id + '">' + escapeHtml(item.title) + '</option>';
      }).join("");
  }

  function renderPosts() {
    var keyword = ($("#postSearch").value || "").trim().toLowerCase();
    var status = $("#postStatusFilter").value;
    var category = $("#postCategoryFilter").value;

    var filtered = state.posts.filter(function (item) {
      var matchKeyword = !keyword ||
        String(item.title || "").toLowerCase().includes(keyword) ||
        String(item.excerpt || "").toLowerCase().includes(keyword) ||
        String(item.slug || "").toLowerCase().includes(keyword);
      var matchStatus = !status || item.status === status;
      var matchCategory = !category || item.category_name === category;
      return matchKeyword && matchStatus && matchCategory;
    });

    $("#postCountText").textContent = "共 " + filtered.length + " 篇";

    if (!filtered.length) {
      $("#postList").innerHTML = '<div class="muted">暂无文章数据</div>';
      return;
    }

    $("#postList").innerHTML = filtered.map(function (item) {
      return (
        '<label class="record-item">' +
          '<input type="checkbox" class="post-check" value="' + item.id + '" />' +
          '<div class="record-item__meta">' +
            '<strong>' + escapeHtml(item.title) + '</strong>' +
            '<div class="record-item__sub">slug: ' + escapeHtml(item.slug) + ' | 状态: ' + escapeHtml(item.status) + ' | 分类: ' + escapeHtml(item.category_name || "未分类") + '</div>' +
            '<div class="record-item__sub">作者: ' + escapeHtml(item.username || "未知") + ' | 浏览: ' + Number(item.view_count || 0) + ' | 评论: ' + Number(item.comment_count || 0) + ' | 点赞: ' + Number(item.like_count || 0) + '</div>' +
          '</div>' +
          '<div class="record-actions">' +
            '<button class="btn btn-secondary" data-action="edit-post" data-id="' + item.id + '">编辑</button>' +
            '<button class="btn btn-danger" data-action="delete-post" data-id="' + item.id + '">删除</button>' +
          '</div>' +
        '</label>'
      );
    }).join("");
  }

  function resetPostForm() {
    $("#postForm").reset();
    $("#postForm").elements.id.value = "";
    state.editingPostId = null;
    $("#editorTitle").textContent = "新建文章";
    renderPostPreview();
  }

  function fillPostForm(post) {
    var form = $("#postForm");
    form.elements.id.value = post.id || "";
    form.elements.title.value = post.title || "";
    form.elements.slug.value = post.slug || "";
    form.elements.category.value = post.category_name || "";
    form.elements.tags.value = Array.isArray(post.tags) ? post.tags.join(", ") : "";
    form.elements.status.value = post.status || "draft";
    form.elements.excerpt.value = post.excerpt || "";
    form.elements.contentMarkdown.value = post.content_markdown || post.content_html || "";
    state.editingPostId = post.id;
    $("#editorTitle").textContent = "编辑文章";
    renderPostPreview();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function collectPostFormData(statusOverride) {
    var form = $("#postForm");
    return {
      title: form.elements.title.value.trim(),
      slug: form.elements.slug.value.trim(),
      category: form.elements.category.value.trim(),
      tags: form.elements.tags.value.trim(),
      excerpt: form.elements.excerpt.value.trim(),
      contentMarkdown: form.elements.contentMarkdown.value.trim(),
      contentHtml: window.marked ? marked.parse(form.elements.contentMarkdown.value || "") : form.elements.contentMarkdown.value,
      status: statusOverride || form.elements.status.value,
    };
  }

  function savePost(statusOverride) {
    var payload = collectPostFormData(statusOverride);
    var id = $("#postForm").elements.id.value;

    if (!payload.title) {
      alert("请填写文章标题");
      return;
    }
    if (!payload.contentMarkdown) {
      alert("请填写文章正文");
      return;
    }

    request(id ? "/api/dashboard/posts/" + id : "/api/dashboard/posts", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function () {
      alert(id ? "文章更新成功" : "文章创建成功");
      resetPostForm();
      loadPosts();
    }).catch(function (error) {
      alert(error.message);
    });
  }

  function batchDeletePosts() {
    var ids = $all(".post-check:checked").map(function (node) { return node.value; });
    if (!ids.length) {
      alert("请先选择要删除的文章");
      return;
    }
    if (!window.confirm("确认批量删除选中的文章吗？")) {
      return;
    }

    Promise.all(ids.map(function (id) {
      return request("/api/dashboard/posts/" + id, { method: "DELETE" });
    })).then(function () {
      loadPosts();
      $("#commentTreeBox").innerHTML = "";
    }).catch(function (error) {
      alert(error.message);
    });
  }

  function loadPosts() {
    return request("/api/dashboard/posts").then(function (result) {
      state.posts = result.items || [];
      fillCategoryFilter();
      renderPosts();
    });
  }

  function renderUsers() {
    if (!state.users.length) {
      $("#userList").innerHTML = '<div class="muted">暂无用户</div>';
      return;
    }

    $("#userList").innerHTML = state.users.map(function (user) {
      return (
        '<article class="record-item">' +
          '<img src="' + escapeHtml(user.avatar_url || "/images/avatar.jpg") + '" alt="头像" style="width:48px;height:48px;border-radius:50%;object-fit:cover;" />' +
          '<div class="record-item__meta">' +
            '<strong>' + escapeHtml(user.username || "未命名用户") + '</strong>' +
            '<div class="record-item__sub">QQ OpenID: ' + escapeHtml(user.qq_openid || "") + '</div>' +
            '<div class="record-item__sub">注册时间: ' + escapeHtml(user.created_at || "") + '</div>' +
          '</div>' +
          '<div class="record-actions">' +
            '<select class="input input-select role-select" data-action="change-role" data-id="' + user.id + '">' +
              '<option value="admin"' + (user.role === "admin" ? " selected" : "") + '>管理员</option>' +
              '<option value="editor"' + (user.role === "editor" ? " selected" : "") + '>编辑者</option>' +
              '<option value="user"' + (user.role === "user" ? " selected" : "") + '>普通用户</option>' +
            '</select>' +
          '</div>' +
        '</article>'
      );
    }).join("");
  }

  function loadUsers() {
    return request("/api/dashboard/users").then(function (result) {
      state.users = result.items || [];
      renderUsers();
    });
  }

  function renderStats() {
    var views = 0;
    var comments = 0;
    var likes = 0;

    state.stats.forEach(function (item) {
      views += Number(item.view_count || 0);
      comments += Number(item.comment_count || 0);
      likes += Number(item.like_count || 0);
    });

    $("#statViews").textContent = String(views);
    $("#statComments").textContent = String(comments);
    $("#statLikes").textContent = String(likes);

    $("#statsTableBox").innerHTML =
      '<div class="table-wrap"><table class="table">' +
      '<thead><tr><th>日期</th><th>类型</th><th>浏览量</th><th>评论数</th><th>点赞数</th></tr></thead>' +
      '<tbody>' +
      (state.stats.length
        ? state.stats.map(function (item) {
            return '<tr><td>' + escapeHtml(item.stat_date) + '</td><td>' + escapeHtml(item.stat_type) + '</td><td>' + Number(item.view_count || 0) + '</td><td>' + Number(item.comment_count || 0) + '</td><td>' + Number(item.like_count || 0) + '</td></tr>';
          }).join("")
        : '<tr><td colspan="5">暂无统计数据</td></tr>') +
      '</tbody></table></div>';
  }

  function loadStats() {
    var range = $("#statsRange").value;
    return request("/api/dashboard/stats?range=" + encodeURIComponent(range)).then(function (result) {
      state.stats = result.items || [];
      renderStats();
    });
  }

  function buildCommentTree(items) {
    var map = {};
    var roots = [];

    items.forEach(function (item) {
      map[item.id] = {
        id: item.id,
        post_id: item.post_id,
        user_id: item.user_id,
        parent_id: item.parent_id,
        reply_to_user_id: item.reply_to_user_id,
        reply_to_username: item.reply_to_username,
        username: item.username,
        avatar_url: item.avatar_url,
        content: item.content,
        like_count: item.like_count,
        created_at: item.created_at,
        children: [],
      };
    });

    items.forEach(function (item) {
      if (item.parent_id && map[item.parent_id]) {
        map[item.parent_id].children.push(map[item.id]);
      } else {
        roots.push(map[item.id]);
      }
    });

    return roots;
  }

  function renderCommentNode(node, depth) {
    var collapsed = depth >= 3 && node.children.length;
    var replyPrefix = node.reply_to_username ? "@" + node.reply_to_username + " " : "";

    return (
      '<div class="comment-node depth-' + depth + '">' +
        '<img src="' + escapeHtml(node.avatar_url || "/images/avatar.jpg") + '" alt="头像" />' +
        '<div class="comment-node__body">' +
          '<div class="comment-node__head">' +
            '<strong>' + escapeHtml(node.username || "未知用户") + '</strong>' +
            '<span>' + escapeHtml(node.created_at || "") + '</span>' +
            '<span>点赞 ' + Number(node.like_count || 0) + '</span>' +
          '</div>' +
          '<p>' + escapeHtml(replyPrefix + (node.content || "")) + '</p>' +
          '<div class="comment-node__actions">' +
            '<button class="btn btn-danger" data-action="delete-comment" data-id="' + node.id + '">删除评论</button>' +
            (collapsed ? '<button class="btn btn-secondary" data-action="expand-comment" data-id="' + node.id + '">展开更多回复</button>' : '') +
          '</div>' +
          '<div class="comment-children" id="comment-children-' + node.id + '">' +
            (collapsed ? '' : node.children.map(function (child) { return renderCommentNode(child, depth + 1); }).join("")) +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderComments() {
    var roots = buildCommentTree(state.currentComments);
    if (!roots.length) {
      $("#commentTreeBox").innerHTML = '<div class="muted">该文章暂无评论</div>';
      return;
    }

    $("#commentTreeBox").innerHTML = roots.map(function (node) {
      return renderCommentNode(node, 1);
    }).join("");
  }

  function loadComments(postId) {
    if (!postId) {
      $("#commentTreeBox").innerHTML = '<div class="muted">请选择文章后查看评论</div>';
      return;
    }

    state.currentCommentPostId = postId;
    request("/api/dashboard/posts/" + encodeURIComponent(postId) + "/comments").then(function (result) {
      state.currentComments = result.items || [];
      renderComments();
    }).catch(function (error) {
      alert(error.message);
    });
  }

  function importArticleFile(file) {
    var formData = new FormData();
    formData.append("file", file);

    request("/api/dashboard/posts/import", {
      method: "POST",
      body: formData,
    }).then(function (result) {
      var form = $("#postForm");
      form.elements.title.value = result.title || "";
      form.elements.excerpt.value = result.excerpt || "";
      form.elements.contentMarkdown.value = result.contentMarkdown || "";
      $("#postPreview").innerHTML = result.contentHtml || "";
    }).catch(function (error) {
      alert(error.message);
    });
  }

  function loadCurrentUser() {
    return request("/api/auth/me").then(function (result) {
      state.user = result.user || null;
      renderUserBox();
    }).catch(function () {
      state.user = null;
      renderUserBox();
    });
  }

  function bindEvents() {
    $all(".admin-nav__item").forEach(function (button) {
      button.onclick = function () { setActiveTab(button.dataset.tab); };
    });

    $("#postContentInput").addEventListener("input", renderPostPreview);
    $("#newPostBtn").onclick = resetPostForm;
    $("#resetPostFormBtn").onclick = resetPostForm;
    $("#saveDraftBtn").onclick = function () { savePost("draft"); };
    $("#publishPostBtn").onclick = function () { savePost("published"); };
    $("#refreshPostsBtn").onclick = loadPosts;
    $("#refreshUsersBtn").onclick = loadUsers;
    $("#refreshStatsBtn").onclick = loadStats;
    $("#loadCommentsBtn").onclick = function () { loadComments($("#commentPostFilter").value); };
    $("#postSearch").oninput = renderPosts;
    $("#postStatusFilter").onchange = renderPosts;
    $("#postCategoryFilter").onchange = renderPosts;
    $("#batchDeleteBtn").onclick = batchDeletePosts;
    $("#importPostBtn").onclick = function () { $("#postFileInput").click(); };
    $("#postFileInput").onchange = function () {
      if (this.files && this.files[0]) {
        importArticleFile(this.files[0]);
      }
    };
    $("#statsRange").onchange = loadStats;
    $("#exportStatsBtn").onclick = function () { window.open("/api/dashboard/stats/export", "_blank"); };
    $("#resetStatsBtn").onclick = function () {
      if (!window.confirm("确认将浏览量、评论数、点赞数等统计从 0 开始重新统计吗？")) { return; }
      request("/api/dashboard/stats/reset", { method: "POST" }).then(function () {
        alert("统计已重置");
        loadStats();
        loadPosts();
      }).catch(function (error) {
        alert(error.message);
      });
    };

    document.addEventListener("click", function (event) {
      var target = event.target.closest("[data-action]");
      if (!target) { return; }

      var action = target.dataset.action;
      if (action === "edit-post") {
        var post = state.posts.find(function (item) { return String(item.id) === String(target.dataset.id); });
        if (post) { fillPostForm(post); }
        return;
      }

      if (action === "delete-post") {
        if (!window.confirm("确认删除这篇文章吗？")) { return; }
        request("/api/dashboard/posts/" + encodeURIComponent(target.dataset.id), { method: "DELETE" }).then(function () {
          loadPosts();
          if (state.currentCommentPostId === target.dataset.id) {
            $("#commentTreeBox").innerHTML = "";
          }
        }).catch(function (error) { alert(error.message); });
        return;
      }

      if (action === "delete-comment") {
        if (!window.confirm("确认删除这条评论吗？")) { return; }
        request("/api/dashboard/comments/" + encodeURIComponent(target.dataset.id), { method: "DELETE" }).then(function () {
          loadComments(state.currentCommentPostId);
          loadPosts();
        }).catch(function (error) { alert(error.message); });
        return;
      }

      if (action === "expand-comment") {
        var roots = buildCommentTree(state.currentComments);
        var queue = roots.slice();
        var matched = null;
        while (queue.length) {
          var current = queue.shift();
          if (String(current.id) === String(target.dataset.id)) {
            matched = current;
            break;
          }
          if (current.children && current.children.length) {
            queue = current.children.concat(queue);
          }
        }

        if (matched) {
          $("#comment-children-" + target.dataset.id).innerHTML = matched.children.map(function (child) {
            return renderCommentNode(child, 4);
          }).join("");
          target.remove();
        }
      }
    });

    document.addEventListener("change", function (event) {
      var select = event.target.closest("[data-action='change-role']");
      if (!select) { return; }
      request("/api/dashboard/users/" + encodeURIComponent(select.dataset.id) + "/role", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: select.value }),
      }).then(function () {
        loadUsers();
      }).catch(function (error) {
        alert(error.message);
      });
    });
  }

  function init() {
    bindEvents();
    renderPostPreview();

    Promise.all([loadCurrentUser(), loadPosts(), loadUsers(), loadStats()]).catch(function (error) {
      console.error(error);
      alert("后台初始化失败：" + error.message);
    });
  }

  init();
})();
