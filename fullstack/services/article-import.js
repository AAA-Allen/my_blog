const fs = require("fs/promises");
const path = require("path");
const mammoth = require("mammoth");
const sanitizeHtml = require("sanitize-html");
const { marked } = require("marked");

let libreofficeConvert = null;
try {
  libreofficeConvert = require("libreoffice-convert");
} catch (_error) {
  libreofficeConvert = null;
}

marked.setOptions({
  gfm: true,
  breaks: true,
});

function cleanHtml(html) {
  return sanitizeHtml(String(html || ""), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "video", "audio", "iframe", "h1", "h2", "h3"]),
    allowedAttributes: {
      "*": ["class", "style"],
      a: ["href", "target", "rel"],
      img: ["src", "alt"],
      video: ["src", "controls", "poster"],
      audio: ["src", "controls"],
      iframe: ["src", "allowfullscreen", "frameborder"],
    },
  });
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(text) {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);

  return (line || "未命名文章").replace(/^#+\s*/, "").trim();
}

function convertDocToDocx(inputPath) {
  return new Promise((resolve, reject) => {
    if (!libreofficeConvert) {
      const error = new Error("当前环境未启用 .doc 转换，请安装 LibreOffice 并保留 libreoffice-convert 依赖。");
      error.statusCode = 400;
      reject(error);
      return;
    }

    fs.readFile(inputPath)
      .then((buffer) => {
        libreofficeConvert.convert(buffer, ".docx", undefined, async (error, done) => {
          if (error) {
            reject(error);
            return;
          }

          const outputPath = inputPath + ".converted.docx";
          await fs.writeFile(outputPath, done);
          resolve(outputPath);
        });
      })
      .catch(reject);
  });
}

async function parseMarkdownFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const html = cleanHtml(marked.parse(raw));

  return {
    title: extractTitle(raw),
    excerpt: stripHtml(raw).slice(0, 180),
    contentMarkdown: raw,
    contentHtml: html,
    sourceType: "markdown",
  };
}

async function parseDocxFile(filePath, sourceType) {
  const htmlResult = await mammoth.convertToHtml({ path: filePath });
  const textResult = await mammoth.extractRawText({ path: filePath });
  const rawText = String(textResult.value || "");

  return {
    title: extractTitle(rawText),
    excerpt: stripHtml(rawText).slice(0, 180),
    contentMarkdown: rawText,
    contentHtml: cleanHtml(htmlResult.value),
    sourceType,
  };
}

async function importArticleFromFile(filePath, originalName) {
  const ext = path.extname(String(originalName || "")).toLowerCase();

  if (ext === ".md") {
    return parseMarkdownFile(filePath);
  }

  if (ext === ".docx") {
    return parseDocxFile(filePath, "docx");
  }

  if (ext === ".doc") {
    const convertedPath = await convertDocToDocx(filePath);
    try {
      return await parseDocxFile(convertedPath, "doc");
    } finally {
      await fs.unlink(convertedPath).catch(() => undefined);
    }
  }

  const error = new Error("仅支持 .md、.doc、.docx 文件上传。");
  error.statusCode = 400;
  throw error;
}

function renderEditorContent(markdownContent) {
  return cleanHtml(marked.parse(String(markdownContent || "")));
}

module.exports = {
  importArticleFromFile,
  renderEditorContent,
};
