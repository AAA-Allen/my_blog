# 朝花夕拾博客

当前主站是 `fullstack/` 下的 Express 动态博客。读者无需注册或登录，可以浏览公开内容并在社区发帖、评论和点赞；文章、歌单、统计及社区内容删除仅对站长开放。

## 本地运行

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`，至少设置：

```dotenv
ADMIN_PASSWORD=请填写站长后台强密码
ADMIN_SESSION_SECRET=请填写至少32字符的随机密钥
```

然后启动：

```powershell
npm start
```

- 博客：<http://localhost:4321>
- 站长后台：<http://localhost:4321/admin>
- 健康检查：<http://localhost:4321/healthz>
- RSS：<http://localhost:4321/rss.xml>
- Sitemap：<http://localhost:4321/sitemap.xml>
- 照片墙：<http://localhost:4321/photos>

开发环境没有设置站长密码时，服务会在启动日志中打印本次进程使用的临时密码；重启后临时密码和登录状态都会失效。生产环境不会启用临时密码。

后台文章编辑支持 Markdown/HTML 安全预览、草稿、定时发布、浏览器自动保存、最近 30 个历史版本，以及 JPG/PNG/WebP/GIF 图片上传。草稿和未到发布时间的文章不会出现在公开接口、搜索、RSS 或 sitemap 中。

媒体库会校验图片真实格式，自动旋转并生成 480、960、1600 和原图四档 WebP，提取相机/镜头等安全 EXIF 字段且不公开 GPS。图片可加入照片墙或作为文章独立封面；仍被文章引用的媒体不能直接删除。后台也可以维护网站标题、公告、关于页、头像和社交主页。

## Render 部署

`render.yaml` 要求在 Render 控制台设置以下秘密：

- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`

不要把真实密码或密钥提交到 Git。运行时内容目前仍保存在 `fullstack/data/site-data.json`；正式部署若需要可靠保留文章、社区和统计数据，应迁移到持久数据库。

上传图片默认写入 `fullstack/uploads/`。Render 的临时文件系统会在重新部署后清空，因此生产环境需要挂载持久磁盘，并把 `BLOG_UPLOAD_DIR` 指向该磁盘目录；文章 JSON 也应通过 `BLOG_DATA_PATH` 放到同一持久层，或迁移到数据库。

## Hexo 静态版本

仓库同时保留了一套独立的 Hexo + Butterfly 静态站：

```powershell
npm run build
npm run server
```

Hexo 的 `source/_posts/` 与 Express 主站的 JSON 内容不会自动同步，部署时请明确选择其中一套作为主站。
