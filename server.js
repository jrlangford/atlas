import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, extname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const ROOT_NAME = basename(ROOT);
const VENDOR_DIR = join(dirname(resolve(import.meta.filename)), "vendor");
const PORT = parseInt(process.env.PORT || "8881", 10);
const ADDR = process.env.ADDRESS || "127.0.0.1";

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

// Image extensions — served as dedicated view page for browser navigation,
// raw bytes for markdown img embeds
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif",
]);

const COMPRESSIBLE = new Set([
  "text/html", "text/css", "application/javascript", "application/json",
  "image/svg+xml",
]);

// Extensions rendered as syntax-highlighted code pages (instead of download)
const CODE_EXTENSIONS = new Set([
  ".txt", ".log",
  ".yaml", ".yml", ".json", ".toml", ".ini", ".cfg", ".conf",
  ".py", ".ts", ".js", ".jsx", ".tsx", ".go", ".rs", ".rb", ".java",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".swift", ".kt",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".gql",
  ".html", ".css", ".scss", ".less",
  ".xml", ".csv", ".env", ".properties",
  ".dockerfile", ".tf", ".hcl", ".nix", ".kdl",
  ".lua", ".r", ".pl", ".ex", ".exs", ".erl",
  ".makefile", ".cmake",
  ".proto", ".avsc",
]);

// Map file extensions to highlight.js language identifiers
const EXT_TO_LANG = {
  ".txt": "plaintext", ".log": "plaintext",
  ".yaml": "yaml", ".yml": "yaml", ".json": "json", ".toml": "toml",
  ".ini": "ini", ".cfg": "ini", ".conf": "nginx", ".properties": "properties",
  ".py": "python", ".ts": "typescript", ".js": "javascript",
  ".jsx": "javascript", ".tsx": "typescript",
  ".go": "go", ".rs": "rust", ".rb": "ruby", ".java": "java",
  ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
  ".cs": "csharp", ".swift": "swift", ".kt": "kotlin",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".fish": "fish",
  ".sql": "sql", ".graphql": "graphql", ".gql": "graphql",
  ".html": "html", ".css": "css", ".scss": "scss", ".less": "less",
  ".xml": "xml", ".csv": "plaintext", ".env": "bash",
  ".dockerfile": "dockerfile", ".tf": "hcl", ".hcl": "hcl", ".nix": "nix",
  ".kdl": "plaintext", ".lua": "lua", ".r": "r", ".pl": "perl",
  ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
  ".makefile": "makefile", ".cmake": "cmake",
  ".proto": "protobuf", ".avsc": "json",
};

function guessLangFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  if (lower === "justfile") return "makefile";
  return null;
}

// --- Gzip + ETag response helper ---

function sendResponse(req, res, statusCode, contentType, body) {
  const etag = '"' + createHash("md5").update(body).digest("hex") + '"';
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  const headers = { "Content-Type": contentType, "ETag": etag };
  const acceptGzip = (req.headers["accept-encoding"] || "").includes("gzip");
  const baseType = contentType.split(";")[0].trim();

  if (acceptGzip && COMPRESSIBLE.has(baseType) && body.length > 1024) {
    const compressed = gzipSync(body);
    headers["Content-Encoding"] = "gzip";
    headers["Content-Length"] = compressed.length;
    res.writeHead(statusCode, headers);
    res.end(compressed);
  } else {
    headers["Content-Length"] = Buffer.byteLength(body);
    res.writeHead(statusCode, headers);
    res.end(body);
  }
}

// --- Vendor asset cache (loaded once at startup, pre-compressed) ---

const vendorCache = new Map();

async function loadVendorAssets(dir = VENDOR_DIR, prefix = "") {
  // Recursive so asset bundles with subdirs (e.g. KaTeX's fonts/) are served.
  // Cache keys are posix-relative paths ("fonts/KaTeX_Main-Regular.woff2") to
  // match the vendor route, which keys on the URL suffix after "/_vendor/".
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await loadVendorAssets(join(dir, entry.name), rel);
      continue;
    }
    const data = await readFile(join(dir, entry.name));
    const ext = extname(entry.name).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    const etag = '"' + createHash("md5").update(data).digest("hex") + '"';
    const baseType = mime.split(";")[0].trim();
    const gzipped = COMPRESSIBLE.has(baseType) ? gzipSync(data) : null;
    vendorCache.set(rel, { data, mime, etag, gzipped });
  }
}

// --- File tree builder ---

// Opt-in: follow symlinked directories in the sidebar tree so an aggregate dir
// of symlinks (e.g. → each agent's workdir) is browsable. Off by default so
// existing instances are unaffected. MAX_TREE_DEPTH bounds symlink cycles.
const FOLLOW_SYMLINKS = process.env.ATLAS_FOLLOW_SYMLINKS === "1";
const MAX_TREE_DEPTH = 12;

async function buildTree(dir, urlBase, depth = 0) {
  const entries = await readdir(dir, { withFileTypes: true });
  const sorted = entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
    .sort((a, b) => {
      const aDir = a.isDirectory();
      const bDir = b.isDirectory();
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  let html = "<ul>";
  for (const entry of sorted) {
    const full = join(dir, entry.name);
    let isDir = entry.isDirectory();
    let followedLink = false;
    // Resolve symlinked directories when following is enabled (dirent type
    // reflects the link itself, so stat the target). Followed dirs are shown as
    // navigable entries but NOT recursed into the sidebar — an aggregate of
    // symlinked workdirs is far too large to inline (14MB+); users drill in via
    // the directory-listing pages instead.
    if (!isDir && FOLLOW_SYMLINKS && entry.isSymbolicLink()) {
      const target = await stat(full).catch(() => null);
      isDir = target?.isDirectory() ?? false;
      followedLink = isDir;
    }
    const href = urlBase + entry.name + (isDir ? "/" : "");
    if (isDir) {
      if (followedLink) {
        // Symlinked dir: a navigable LINK (no pre-built subtree — an aggregate
        // of full workdirs is far too large to inline). Click loads its
        // directory-listing page; drill down from there.
        html += `<li class="tree-dir"><a href="${href}">📁 ${entry.name}</a></li>`;
      } else {
        const children = depth >= MAX_TREE_DEPTH ? "" : await buildTree(full, href, depth + 1);
        html += `<li class="tree-dir"><span class="tree-toggle" onclick="this.parentElement.classList.toggle('open')">📁 ${entry.name}</span>${children}</li>`;
      }
    } else {
      const lower = entry.name.toLowerCase();
      const ext = extname(lower);
      if (lower.endsWith(".md") || CODE_EXTENSIONS.has(ext) || lower === "dockerfile" || lower === "makefile" || lower === "justfile") {
        html += `<li class="tree-file"><a href="${href}">📄 ${entry.name}</a></li>`;
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        html += `<li class="tree-file"><a href="${href}">🖼 ${entry.name}</a></li>`;
      } else if (ext === ".pdf") {
        html += `<li class="tree-file"><a href="${href}">📕 ${entry.name}</a></li>`;
      } else {
        // Any other file type — Atlas doesn't render it, but surface it as a
        // downloadable entry so it's findable in nav rather than reachable only
        // by a URL you already know (e.g. .docx / .xlsx / .zip). Serving is
        // unchanged (raw octet-stream); this only makes it visible in the sidebar.
        html += `<li class="tree-file"><a href="${href}" download>📎 ${entry.name}</a></li>`;
      }
    }
  }
  html += "</ul>";
  return html;
}

// Cache the sidebar tree (rebuild every 30s)
let sidebarCache = "";
let sidebarCacheTime = 0;
const SIDEBAR_TTL = 30_000;

async function getSidebar() {
  const now = Date.now();
  if (now - sidebarCacheTime < SIDEBAR_TTL && sidebarCache) return sidebarCache;
  sidebarCache = await buildTree(ROOT, "/");
  sidebarCacheTime = now;
  return sidebarCache;
}

// --- Page builders ---

const PAGE_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{TITLE}}</title>
  <link id="md-css-dark" rel="stylesheet" href="/_vendor/github-markdown-dark.min.css">
  <link id="md-css-light" rel="stylesheet" href="/_vendor/github-markdown-light.min.css" disabled>
  <link id="hljs-css-dark" rel="stylesheet" href="/_vendor/hljs-github-dark.min.css">
  <link id="hljs-css-light" rel="stylesheet" href="/_vendor/hljs-github-light.min.css" disabled>
  <link id="katex-css" rel="stylesheet" href="/_vendor/katex.min.css">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; transition: background 0.2s, color 0.2s; display: flex; min-height: 100vh; }
    body.dark { background: #0d1117; color: #e6edf3; }
    body.light { background: #fff; color: #1f2328; }

    /* Sidebar */
    .sidebar { width: 280px; min-width: 280px; padding: 16px; overflow-y: auto; border-right: 1px solid; position: fixed; top: 0; left: 0; bottom: 0; transition: transform 0.2s ease; z-index: 10; }
    .sidebar.collapsed { transform: translateX(-280px); }
    body.dark .sidebar { background: #010409; border-color: #21262d; }
    body.light .sidebar { background: #f6f8fa; border-color: #d1d9e0; }
    .sidebar-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid; gap: 6px; }
    body.dark .sidebar-header { border-color: #21262d; }
    body.light .sidebar-header { border-color: #d1d9e0; }
    .sidebar-title { font-weight: 600; font-size: 15px; flex: 1; }
    body.dark .sidebar-title a { color: #e6edf3; }
    body.light .sidebar-title a { color: #1f2328; }
    .sidebar-title a { text-decoration: none; }
    .sidebar-title a:hover { text-decoration: underline; }
    .theme-toggle { cursor: pointer; background: none; border: 1px solid #444; border-radius: 6px; padding: 2px 8px; font-size: 14px; line-height: 1; }
    body.dark .theme-toggle { border-color: #444; color: #e6edf3; }
    body.light .theme-toggle { border-color: #ccc; color: #1f2328; }

    /* Sidebar pull-tab — fixed position, slides with sidebar */
    .sidebar-tab { position: fixed; top: 12px; left: 280px; width: 24px; height: 32px; cursor: pointer; border: 1px solid; border-left: none; border-radius: 0 6px 6px 0; display: flex; align-items: center; justify-content: center; font-size: 12px; z-index: 11; transition: left 0.2s ease; }
    .sidebar-tab.shifted { left: 0; }
    body.dark .sidebar-tab { background: #010409; border-color: #21262d; color: #8b949e; }
    body.light .sidebar-tab { background: #f6f8fa; border-color: #d1d9e0; color: #656d76; }
    .sidebar-tab:hover { opacity: 1; }
    body.dark .sidebar-tab:hover { color: #e6edf3; }
    body.light .sidebar-tab:hover { color: #1f2328; }

    /* Menu toggle (mobile only — inline in top-bar) */
    .menu-toggle { cursor: pointer; background: none; border: 1px solid; border-radius: 6px; padding: 2px 8px; font-size: 16px; line-height: 1; flex-shrink: 0; display: none; }
    body.dark .menu-toggle { border-color: #444; color: #e6edf3; }
    body.light .menu-toggle { border-color: #ccc; color: #1f2328; }

    /* Tree */
    .sidebar ul { list-style: none; padding-left: 14px; margin: 0; }
    .sidebar > ul { padding-left: 0; }
    .tree-dir > ul { display: none; }
    .tree-dir.open > ul { display: block; }
    .tree-toggle { cursor: pointer; user-select: none; display: block; padding: 3px 0; font-size: 13px; }
    .tree-toggle:hover { text-decoration: underline; }
    .tree-file { padding: 3px 0; font-size: 13px; }
    .tree-file a { text-decoration: none; }
    .tree-file a:hover { text-decoration: underline; }
    body.dark .tree-file a { color: #58a6ff; }
    body.light .tree-file a { color: #0969da; }
    body.dark .tree-toggle { color: #e6edf3; }
    body.light .tree-toggle { color: #1f2328; }
    .tree-file a.active { font-weight: 600; }

    /* Main content */
    .main { margin-left: 280px; flex: 1; padding: 20px; width: calc(100% - 280px); transition: margin-left 0.2s ease, width 0.2s ease; }
    .main.expanded { margin-left: 0; width: 100%; }
    .top-bar { max-width: 980px; margin: 0 auto 12px; padding: 0 24px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .breadcrumb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    body.dark .breadcrumb a { color: #58a6ff; }
    body.light .breadcrumb a { color: #0969da; }
    .breadcrumb a { text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    .markdown-body { max-width: 980px; margin: 0 auto; padding: 24px; }
    .dir-listing { list-style: none; padding: 0; }
    .dir-listing li { padding: 8px 0; }
    body.dark .dir-listing li { border-bottom: 1px solid #21262d; }
    body.light .dir-listing li { border-bottom: 1px solid #d1d9e0; }
    .dir-listing li:last-child { border-bottom: none; }
    body.dark .dir-listing a { color: #58a6ff; }
    body.light .dir-listing a { color: #0969da; }
    .dir-listing a { text-decoration: none; font-size: 15px; }
    .dir-listing a:hover { text-decoration: underline; }
    .dir-listing .icon { margin-right: 8px; }
    body.dark pre code.hljs { background: #161b22; border-radius: 6px; }
    body.light pre code.hljs { background: #f6f8fa; border-radius: 6px; }

    /* Image view */
    .image-view { max-width: 100%; }
    .image-view h1 { margin-top: 0; margin-bottom: 8px; word-break: break-all; }
    .image-meta { font-size: 13px; margin-bottom: 16px; }
    body.dark .image-meta { color: #8b949e; }
    body.light .image-meta { color: #656d76; }
    .image-actions { margin-bottom: 20px; display: flex; gap: 8px; flex-wrap: wrap; }
    .download-btn { display: inline-block; padding: 6px 14px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500; border: 1px solid transparent; }
    body.dark .download-btn { background: #238636; color: #fff; border-color: #2ea043; }
    body.light .download-btn { background: #2da44e; color: #fff; border-color: #2c974b; }
    .download-btn:hover { opacity: 0.9; text-decoration: none; }
    .image-container { text-align: center; padding: 12px; border-radius: 6px; }
    body.dark .image-container { background: #161b22; border: 1px solid #21262d; }
    body.light .image-container { background: #f6f8fa; border: 1px solid #d1d9e0; }
    .image-container img { max-width: 100%; height: auto; border-radius: 4px; }
    .download-btn.secondary { background: transparent; }
    body.dark .download-btn.secondary { color: #58a6ff; border-color: #30363d; }
    body.light .download-btn.secondary { color: #0969da; border-color: #d1d9e0; }

    /* PDF view — browser-native viewer inside an iframe */
    .pdf-view { max-width: 100%; }
    .pdf-view h1 { margin-top: 0; margin-bottom: 8px; word-break: break-all; }
    .pdf-actions { margin-bottom: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
    .pdf-frame { width: 100%; height: calc(100vh - 160px); min-height: 480px; border-radius: 6px; }
    body.dark .pdf-frame { border: 1px solid #21262d; background: #161b22; }
    body.light .pdf-frame { border: 1px solid #d1d9e0; background: #f6f8fa; }

    /* Generic download view — non-previewable file types */
    .download-view { max-width: 640px; margin: 40px auto; text-align: center; }
    .download-view h1 { word-break: break-all; margin-bottom: 4px; }
    .download-icon { font-size: 56px; line-height: 1; margin-bottom: 12px; }
    .download-note { font-size: 13px; margin-top: 16px; }
    body.dark .download-note { color: #8b949e; }
    body.light .download-note { color: #656d76; }

    /* Top-bar download button (universal, for any file view) */
    .top-dl { flex-shrink: 0; text-decoration: none; border: 1px solid; border-radius: 6px; padding: 2px 10px; font-size: 14px; line-height: 1.6; }
    body.dark .top-dl { border-color: #30363d; color: #58a6ff; }
    body.light .top-dl { border-color: #d1d9e0; color: #0969da; }
    .top-dl:hover { text-decoration: none; opacity: 0.8; }

    /* Mermaid node text clipping fix — adds breathing room for descenders on multi-line labels */
    .mermaid .nodeLabel { padding-bottom: 4px; }

    /* Overlay backdrop (mobile only) */
    .sidebar-overlay { display: none; position: fixed; inset: 0; z-index: 9; }
    body.dark .sidebar-overlay { background: rgba(0,0,0,0.5); }
    body.light .sidebar-overlay { background: rgba(0,0,0,0.3); }

    /* Mobile */
    @media (max-width: 768px) {
      .main { margin-left: 0; width: 100%; padding: 12px 8px; }
      .top-bar { padding: 0 8px; }
      .markdown-body { padding: 8px; }
      .sidebar { transform: translateX(-280px); }
      .sidebar.open-mobile { transform: translateX(0); }
      .sidebar-overlay.visible { display: block; }
      .menu-toggle { display: inline-block; }
      .sidebar-tab { display: none; }
    }
    /* Pre-paint sidebar collapse (prevents flash on page load) */
    html[data-sidebar="collapsed"] .sidebar { transform: translateX(-280px); }
    html[data-sidebar="collapsed"] .main { margin-left: 0; width: 100%; }
    html[data-sidebar="collapsed"] .sidebar-tab { left: 0; }

    .mermaid .node rect, .mermaid .node polygon, .mermaid .node circle, .mermaid .node .label-container { overflow: visible; }
    .mermaid svg { overflow: visible; }

    /* Native browser printing / Save-as-PDF — strip chrome, force readable colors,
       keep blocks intact across page breaks. */
    @media print {
      .sidebar, .sidebar-tab, .sidebar-overlay, .top-bar, .menu-toggle,
      .theme-toggle, .image-actions, .pdf-actions, .download-btn, .top-dl { display: none !important; }
      body { display: block !important; }
      .main, .main.expanded { margin-left: 0 !important; width: 100% !important; padding: 0 !important; }
      .markdown-body { max-width: 100% !important; margin: 0 !important; padding: 0 !important; }
      /* Bake ~75% of the on-screen 16px base into print so pages come out at a
         comfortable size at the dialog's default 100% Scale — no need to dial the
         Scale down (which sub-pixels thin table borders away, notably in Firefox).
         Headings/spacing are em-relative so they scale with this. */
      .markdown-body { font-size: 12px !important; }
      body, body.dark, body.light { background: #fff !important; color: #000 !important; }
      /* github-markdown-dark sets its own background + heading/text colors at higher
         specificity than body, so print would show a dark band with near-white text.
         Force the container light and the text dark. */
      .main, .markdown-body { background: #fff !important; }
      .markdown-body, .markdown-body h1, .markdown-body h2, .markdown-body h3,
      .markdown-body h4, .markdown-body h5, .markdown-body h6,
      .markdown-body p, .markdown-body li, .markdown-body td, .markdown-body th,
      .markdown-body blockquote, .markdown-body strong, .markdown-body em { color: #000 !important; }
      a { color: #000 !important; text-decoration: underline; }
      pre, code, blockquote, img, .mermaid, .image-container { break-inside: avoid; page-break-inside: avoid; }
      /* Tables flow across pages — fill the current page, continue the remaining
         rows on the next — instead of jumping the whole table to a new page and
         leaving a gap. Individual rows stay intact; the header repeats per page. */
      table { break-inside: auto !important; page-break-inside: auto !important; }
      thead { display: table-header-group; }
      tr, td, th { break-inside: avoid; page-break-inside: avoid; }
      /* Force solid, visible grid lines on white and drop the dark row fills, so
         tables print with borders whether "Print backgrounds" is on or off, in
         both Chrome and Firefox. */
      .markdown-body table, .markdown-body th, .markdown-body td { border: 1px solid #9aa0a6 !important; }
      .markdown-body table tr, .markdown-body th, .markdown-body td { background-color: transparent !important; }
      h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
      pre code.hljs, body.dark pre code.hljs, body.light pre code.hljs { background: #f6f8fa !important; color: #1f2328 !important; }
      .pdf-frame { height: auto !important; min-height: 0 !important; }
    }
  </style>
  <script>
    // Apply sidebar + theme state before first paint to prevent flash
    (function() {
      var t = localStorage.getItem('mdview-theme') || 'dark';
      var s = localStorage.getItem('mdview-sidebar');
      document.documentElement.setAttribute('data-theme', t);
      if (s === 'collapsed') document.documentElement.setAttribute('data-sidebar', 'collapsed');
    })();
  </script>
</head>
<body class="dark">
  <div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleSidebar()"></div>
  <div class="sidebar-tab" id="sidebar-tab" onclick="toggleSidebar()" title="Toggle sidebar">◀</div>
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title"><a href="/">{{ROOT_NAME}}</a></span>
      <button class="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode">🌓</button>
    </div>
    {{SIDEBAR}}
  </aside>
  <div class="main" id="main-content">
    <div class="top-bar">
      <button class="menu-toggle" id="menu-toggle" onclick="toggleSidebar()" title="Toggle sidebar">☰</button>
      <nav class="breadcrumb" id="breadcrumb">{{BREADCRUMB}}</nav>
      <a class="top-dl" id="top-dl" href="#" title="Download raw file" style="display:none">⬇</a>
    </div>
    <article class="markdown-body" id="content-area">{{CONTENT}}</article>
  </div>
  <script src="/_vendor/marked.min.js"></script>
  <script src="/_vendor/highlight.min.js"></script>
  <script src="/_vendor/mermaid.min.js"></script>
  <script src="/_vendor/katex.min.js"></script>
  <script src="/_vendor/atlas-math.js?v=2"></script>
  <script>
    function isMobile() { return window.innerWidth <= 768; }
    function toggleSidebar() {
      var sb = document.getElementById('sidebar');
      var main = document.querySelector('.main');
      var overlay = document.getElementById('sidebar-overlay');
      var tab = document.getElementById('sidebar-tab');

      if (isMobile()) {
        var isOpen = sb.classList.toggle('open-mobile');
        overlay.classList.toggle('visible', isOpen);
      } else {
        var collapsed = sb.classList.toggle('collapsed');
        main.classList.toggle('expanded', collapsed);
        if (tab) { tab.textContent = collapsed ? '▶' : '◀'; tab.classList.toggle('shifted', collapsed); }
        document.documentElement.setAttribute('data-sidebar', collapsed ? 'collapsed' : 'open');
        localStorage.setItem('mdview-sidebar', collapsed ? 'collapsed' : 'open');
      }
    }
    (function() {
      if (!isMobile() && localStorage.getItem('mdview-sidebar') === 'collapsed') {
        document.getElementById('sidebar').classList.add('collapsed');
        document.querySelector('.main').classList.add('expanded');
        var tab = document.getElementById('sidebar-tab');
        if (tab) { tab.textContent = '▶'; tab.classList.add('shifted'); }
      }
    })();

    function getTheme() { return localStorage.getItem('mdview-theme') || 'dark'; }
    function applyTheme(t) {
      document.body.className = t;
      document.getElementById('md-css-dark').disabled = (t !== 'dark');
      document.getElementById('md-css-light').disabled = (t !== 'light');
      document.getElementById('hljs-css-dark').disabled = (t !== 'dark');
      document.getElementById('hljs-css-light').disabled = (t !== 'light');
      localStorage.setItem('mdview-theme', t);
    }
    function toggleTheme() {
      var next = getTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      mermaid.initialize({ startOnLoad: false, theme: next === 'dark' ? 'dark' : 'default', flowchart: { padding: 16, nodeSpacing: 30 } });
      document.querySelectorAll('.mermaid').forEach(function(el) { el.removeAttribute('data-processed'); });
      mermaid.run({ nodes: document.querySelectorAll('.mermaid') });
    }
    applyTheme(getTheme());
    mermaid.initialize({ startOnLoad: false, theme: getTheme() === 'dark' ? 'dark' : 'default', flowchart: { padding: 16, nodeSpacing: 30 } });

    // --- SPA navigation ---

    function esc(s) { return String(s).replace(/[&<>"']/g, function(c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
    function fmtBytes(n) {
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
      if (n < 1073741824) return (n/1048576).toFixed(1) + ' MB';
      return (n/1073741824).toFixed(2) + ' GB';
    }
    function updateDownloadBtn(data) {
      var dl = document.getElementById('top-dl');
      if (!dl) return;
      if (data.type === 'directory') { dl.style.display = 'none'; }
      else { dl.style.display = ''; dl.setAttribute('href', data.path + '?download=1'); }
    }

    function renderContent(data) {
      var area = document.getElementById('content-area');
      var bc = document.getElementById('breadcrumb');
      bc.innerHTML = data.breadcrumb;
      document.title = data.title;
      updateDownloadBtn(data);

      if (data.type === 'directory') {
        area.innerHTML = data.html;
      } else if (data.type === 'markdown') {
        var md = new TextDecoder().decode(Uint8Array.from(atob(data.content), function(c) { return c.charCodeAt(0); }));

        var mermaidExt = {
          extensions: [{
            name: 'mermaidBlock',
            level: 'block',
            start: function(src) { return src.match(/\\\`\\\`\\\`mermaid/)?.index; },
            tokenizer: function(src) {
              var match = src.match(/^\\\`\\\`\\\`mermaid\\n([\\s\\S]*?)\\\`\\\`\\\`/);
              if (match) {
                return { type: 'mermaidBlock', raw: match[0], text: match[1].trim() };
              }
            },
            renderer: function(token) {
              // HTML-escape the diagram source: this string goes through
              // innerHTML, and unescaped mermaid syntax like <<stereotype>>
              // is parsed as HTML tags — the browser swallows them and
              // auto-closes them at the end of the <pre>, so mermaid receives
              // stray </...> tags and bombs with a persistent "Syntax error"
              // (fqbc-obligation-catalog, 2026-08-04). mermaid entity-decodes
              // when reading the node, so escaping round-trips correctly.
              var escaped = token.text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
              return '<pre class="mermaid">' + escaped + '</pre>';
            }
          }]
        };

        marked.use(mermaidExt);
        if (window.AtlasMath) marked.use(window.AtlasMath.ext);
        marked.use({ gfm: true, breaks: false });
        area.innerHTML = marked.parse(md);
        area.querySelectorAll('pre code').forEach(function(el) { hljs.highlightElement(el); });
        mermaid.run({ nodes: area.querySelectorAll('.mermaid') });
        if (window.AtlasMath) window.AtlasMath.render(area);
      } else if (data.type === 'code') {
        var code = new TextDecoder().decode(Uint8Array.from(atob(data.content), function(c) { return c.charCodeAt(0); }));
        var pre = document.createElement('pre');
        var codeEl = document.createElement('code');
        codeEl.className = 'language-' + (data.lang || 'plaintext');
        codeEl.textContent = code;
        pre.appendChild(codeEl);
        area.innerHTML = '';
        area.appendChild(pre);
        hljs.highlightElement(codeEl);
      } else if (data.type === 'image') {
        var fn = esc(data.filename);
        area.innerHTML =
          '<div class="image-view">' +
          '<h1>' + fn + '</h1>' +
          '<div class="image-meta">' + fmtBytes(data.size) + '</div>' +
          '<div class="image-actions">' +
          '<a class="download-btn" href="' + esc(data.downloadUrl) + '" download="' + fn + '">⬇ Download</a>' +
          '</div>' +
          '<div class="image-container">' +
          '<img src="' + esc(data.rawUrl) + '" alt="' + fn + '" />' +
          '</div>' +
          '</div>';
      } else if (data.type === 'pdf') {
        var pfn = esc(data.filename);
        area.innerHTML =
          '<div class="pdf-view">' +
          '<h1>' + pfn + '</h1>' +
          '<div class="image-meta">' + fmtBytes(data.size) + '</div>' +
          '<div class="pdf-actions">' +
          '<a class="download-btn" href="' + esc(data.downloadUrl) + '" download="' + pfn + '">⬇ Download</a>' +
          '<a class="download-btn secondary" href="' + esc(data.rawUrl) + '" target="_blank" rel="noopener">↗ Open full page</a>' +
          '</div>' +
          '<iframe class="pdf-frame" src="' + esc(data.rawUrl) + '" title="' + pfn + '"></iframe>' +
          '</div>';
      } else if (data.type === 'download') {
        var dfn = esc(data.filename);
        area.innerHTML =
          '<div class="download-view">' +
          '<div class="download-icon">📦</div>' +
          '<h1>' + dfn + '</h1>' +
          '<div class="image-meta">' + fmtBytes(data.size) + '</div>' +
          '<div class="image-actions">' +
          '<a class="download-btn" href="' + esc(data.downloadUrl) + '" download="' + dfn + '">⬇ Download</a>' +
          '</div>' +
          '<p class="download-note">This file type can\\'t be previewed in Atlas.</p>' +
          '</div>';
      }

      // Update sidebar active state
      document.querySelectorAll('.tree-file a').forEach(function(a) {
        a.classList.toggle('active', a.getAttribute('href') === data.path);
        if (a.getAttribute('href') === data.path) {
          var li = a.closest('li');
          while (li) {
            if (li.classList.contains('tree-dir')) li.classList.add('open');
            li = li.parentElement?.closest('li');
          }
        }
      });

      // Close mobile sidebar after navigation
      if (isMobile()) {
        document.getElementById('sidebar').classList.remove('open-mobile');
        document.getElementById('sidebar-overlay').classList.remove('visible');
      }

      window.scrollTo(0, 0);
    }

    function navigateTo(url) {
      fetch('/_api/content?path=' + encodeURIComponent(url))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          history.pushState(null, '', url);
          renderContent(data);
        })
        .catch(function() { window.location = url; });
    }

    // Intercept link clicks for SPA navigation
    document.addEventListener('click', function(e) {
      var a = e.target.closest('a');
      if (!a) return;
      var href = a.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('/_') || href.startsWith('#')) return;
      // Let browser handle download links and raw asset URLs natively
      if (a.hasAttribute('download') || href.indexOf('?download') !== -1 || href.indexOf('?raw') !== -1) return;
      e.preventDefault();
      navigateTo(href);
    });

    // Handle back/forward
    window.addEventListener('popstate', function() {
      navigateTo(window.location.pathname);
    });

    // --- Initial page render (from embedded data) ---

    (function() {
      var current = decodeURIComponent(window.location.pathname);
      document.querySelectorAll('.tree-file a').forEach(function(a) {
        if (a.getAttribute('href') === current) {
          a.classList.add('active');
          var li = a.closest('li');
          while (li) {
            if (li.classList.contains('tree-dir')) li.classList.add('open');
            li = li.parentElement?.closest('li');
          }
        }
      });
      // Top-bar download button: shown for file views (path without trailing slash),
      // hidden for directory listings and the root.
      var dl = document.getElementById('top-dl');
      if (dl && current !== '/' && !current.endsWith('/')) {
        dl.style.display = '';
        dl.setAttribute('href', window.location.pathname + '?download=1');
      }
    })();

    var rawCode = document.getElementById('raw-code');
    if (rawCode) {
      try {
        var code = new TextDecoder().decode(Uint8Array.from(atob(rawCode.dataset.content), function(c) { return c.charCodeAt(0); }));
        var lang = rawCode.dataset.lang || 'plaintext';
        var pre = document.createElement('pre');
        var codeEl = document.createElement('code');
        codeEl.className = 'language-' + lang;
        codeEl.textContent = code;
        pre.appendChild(codeEl);
        document.querySelector('.markdown-body').appendChild(pre);
        hljs.highlightElement(codeEl);
      } catch(e) {
        document.querySelector('.markdown-body').innerHTML = '<pre style="color:red">' + e.message + '\\n' + e.stack + '</pre>';
      }
    }

    var raw = document.getElementById('raw-markdown');
    if (raw) {
      try {
        var md = new TextDecoder().decode(Uint8Array.from(atob(raw.dataset.content), function(c) { return c.charCodeAt(0); }));

        var mermaidExt = {
          extensions: [{
            name: 'mermaidBlock',
            level: 'block',
            start: function(src) { return src.match(/\\\`\\\`\\\`mermaid/)?.index; },
            tokenizer: function(src) {
              var match = src.match(/^\\\`\\\`\\\`mermaid\\n([\\s\\S]*?)\\\`\\\`\\\`/);
              if (match) {
                return { type: 'mermaidBlock', raw: match[0], text: match[1].trim() };
              }
            },
            renderer: function(token) {
              // HTML-escape the diagram source: this string goes through
              // innerHTML, and unescaped mermaid syntax like <<stereotype>>
              // is parsed as HTML tags — the browser swallows them and
              // auto-closes them at the end of the <pre>, so mermaid receives
              // stray </...> tags and bombs with a persistent "Syntax error"
              // (fqbc-obligation-catalog, 2026-08-04). mermaid entity-decodes
              // when reading the node, so escaping round-trips correctly.
              var escaped = token.text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
              return '<pre class="mermaid">' + escaped + '</pre>';
            }
          }]
        };

        marked.use(mermaidExt);
        if (window.AtlasMath) marked.use(window.AtlasMath.ext);
        marked.use({ gfm: true, breaks: false });

        document.querySelector('.markdown-body').innerHTML = marked.parse(md);

        document.querySelectorAll('pre code').forEach(function(el) { hljs.highlightElement(el); });
        mermaid.run({ nodes: document.querySelectorAll('.mermaid') });
        if (window.AtlasMath) window.AtlasMath.render(document.querySelector('.markdown-body'));
      } catch(e) {
        document.querySelector('.markdown-body').innerHTML = '<pre style="color:red">' + e.message + '\\n' + e.stack + '</pre>';
      }
    }
  </script>
</body>
</html>`;

function breadcrumb(urlPath) {
  const parts = urlPath.split("/").filter(Boolean);
  let acc = "/";
  let links = [`<a href="/">${ROOT_NAME}</a>`];
  for (const p of parts) {
    acc += p + "/";
    links.push(`<a href="${acc}">${p}</a>`);
  }
  return links.join(" / ");
}

function dirPage(urlPath, entries, sidebar) {
  const items = entries
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((e) => {
      const icon = e.isDir ? "📁" : (IMAGE_EXTENSIONS.has(extname(e.name).toLowerCase()) ? "🖼" : "📄");
      const href = urlPath.replace(/\/?$/, "/") + e.name + (e.isDir ? "/" : "");
      return `<li><span class="icon">${icon}</span><a href="${href}">${e.name}${e.isDir ? "/" : ""}</a></li>`;
    })
    .join("\n");

  const content = `<h1>${urlPath === "/" ? ROOT_NAME : urlPath}</h1>\n<ul class="dir-listing">\n${items}\n</ul>`;
  return PAGE_TEMPLATE
    .replace("{{TITLE}}", urlPath)
    .replace("{{SIDEBAR}}", sidebar)
    .replace("{{BREADCRUMB}}", breadcrumb(urlPath))
    .replace("{{CONTENT}}", content)
    .replace("{{ROOT_NAME}}", ROOT_NAME);
}

// Strip a leading YAML frontmatter block (optionally preceded by HTML comment[s])
// before markdown rendering, so it doesn't show as raw text / <hr> / # headings.
// Anchored at file start; mid-document --- (thematic breaks) are untouched.
// Rendered markdown only — raw/code/download paths keep the full file.
function stripFrontmatter(md) {
  return md.replace(/^\s*(?:<!--[\s\S]*?-->\s*)*---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

function mdPage(urlPath, markdown, sidebar) {
  const b64 = Buffer.from(stripFrontmatter(markdown), "utf-8").toString("base64");
  const content = `<div id="raw-markdown" data-content="${b64}"></div>`;
  return PAGE_TEMPLATE
    .replace("{{TITLE}}", urlPath)
    .replace("{{SIDEBAR}}", sidebar)
    .replace("{{BREADCRUMB}}", breadcrumb(urlPath))
    .replace("{{CONTENT}}", content)
    .replace("{{ROOT_NAME}}", ROOT_NAME);
}

function codePage(urlPath, code, ext, filename, sidebar) {
  const lang = EXT_TO_LANG[ext] || guessLangFromFilename(filename) || "plaintext";
  const b64 = Buffer.from(code, "utf-8").toString("base64");
  const content = `<div id="raw-code" data-content="${b64}" data-lang="${lang}"></div>`;
  return PAGE_TEMPLATE
    .replace("{{TITLE}}", urlPath)
    .replace("{{SIDEBAR}}", sidebar)
    .replace("{{BREADCRUMB}}", breadcrumb(urlPath))
    .replace("{{CONTENT}}", content)
    .replace("{{ROOT_NAME}}", ROOT_NAME);
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function imagePage(urlPath, filename, size, sidebar) {
  const safeFilename = escHtml(filename);
  const safeUrl = escHtml(urlPath);
  const content = `<div class="image-view">
  <h1>${safeFilename}</h1>
  <div class="image-meta">${formatBytes(size)}</div>
  <div class="image-actions">
    <a class="download-btn" href="${safeUrl}?download=1" download="${safeFilename}">⬇ Download</a>
  </div>
  <div class="image-container">
    <img src="${safeUrl}?raw=1" alt="${safeFilename}" />
  </div>
</div>`;
  return PAGE_TEMPLATE
    .replace("{{TITLE}}", urlPath)
    .replace("{{SIDEBAR}}", sidebar)
    .replace("{{BREADCRUMB}}", breadcrumb(urlPath))
    .replace("{{CONTENT}}", content)
    .replace("{{ROOT_NAME}}", ROOT_NAME);
}

// PDF view page — hands the raw bytes to the browser's built-in PDF viewer via an
// iframe, inside Atlas chrome, with download + open-full-page actions.
function pdfPage(urlPath, filename, size, sidebar) {
  const safeFilename = escHtml(filename);
  const safeUrl = escHtml(urlPath);
  const content = `<div class="pdf-view">
  <h1>${safeFilename}</h1>
  <div class="image-meta">${formatBytes(size)}</div>
  <div class="pdf-actions">
    <a class="download-btn" href="${safeUrl}?download=1" download="${safeFilename}">⬇ Download</a>
    <a class="download-btn secondary" href="${safeUrl}?raw=1" target="_blank" rel="noopener">↗ Open full page</a>
  </div>
  <iframe class="pdf-frame" src="${safeUrl}?raw=1" title="${safeFilename}"></iframe>
</div>`;
  return PAGE_TEMPLATE
    .replace("{{TITLE}}", urlPath)
    .replace("{{SIDEBAR}}", sidebar)
    .replace("{{BREADCRUMB}}", breadcrumb(urlPath))
    .replace("{{CONTENT}}", content)
    .replace("{{ROOT_NAME}}", ROOT_NAME);
}

// Generic download landing page — non-previewable file types (docx, xlsx, zip, …).
function downloadPage(urlPath, filename, size, sidebar) {
  const safeFilename = escHtml(filename);
  const safeUrl = escHtml(urlPath);
  const content = `<div class="download-view">
  <div class="download-icon">📦</div>
  <h1>${safeFilename}</h1>
  <div class="image-meta">${formatBytes(size)}</div>
  <div class="image-actions">
    <a class="download-btn" href="${safeUrl}?download=1" download="${safeFilename}">⬇ Download</a>
  </div>
  <p class="download-note">This file type can't be previewed in Atlas.</p>
</div>`;
  return PAGE_TEMPLATE
    .replace("{{TITLE}}", urlPath)
    .replace("{{SIDEBAR}}", sidebar)
    .replace("{{BREADCRUMB}}", breadcrumb(urlPath))
    .replace("{{CONTENT}}", content)
    .replace("{{ROOT_NAME}}", ROOT_NAME);
}

// --- Content API for SPA navigation ---

async function apiContent(urlPath) {
  const fsPath = join(ROOT, urlPath);
  if (!resolve(fsPath).startsWith(ROOT)) return { error: "Forbidden" };

  const st = await stat(fsPath).catch(() => null);
  if (!st) return { error: "Not found" };

  const result = { path: urlPath, breadcrumb: breadcrumb(urlPath), title: urlPath };

  if (st.isDirectory()) {
    const entries = await readdir(fsPath, { withFileTypes: true });
    const list = entries
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => {
        const aDir = a.isDirectory();
        const bDir = b.isDirectory();
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => {
        const isDir = e.isDirectory();
        const icon = isDir ? "📁" : (IMAGE_EXTENSIONS.has(extname(e.name).toLowerCase()) ? "🖼" : "📄");
        const href = urlPath.replace(/\/?$/, "/") + e.name + (isDir ? "/" : "");
        return `<li><span class="icon">${icon}</span><a href="${href}">${e.name}${isDir ? "/" : ""}</a></li>`;
      })
      .join("\n");
    result.type = "directory";
    result.html = `<h1>${urlPath === "/" ? ROOT_NAME : urlPath}</h1>\n<ul class="dir-listing">\n${list}\n</ul>`;
    return result;
  }

  const ext = extname(fsPath).toLowerCase();
  const filename = fsPath.split("/").pop();

  if (ext === ".md") {
    const content = await readFile(fsPath, "utf-8");
    result.type = "markdown";
    result.content = Buffer.from(stripFrontmatter(content), "utf-8").toString("base64");
    return result;
  }

  if (CODE_EXTENSIONS.has(ext) || guessLangFromFilename(filename)) {
    const content = await readFile(fsPath, "utf-8");
    result.type = "code";
    result.content = Buffer.from(content, "utf-8").toString("base64");
    result.lang = EXT_TO_LANG[ext] || guessLangFromFilename(filename) || "plaintext";
    return result;
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    result.type = "image";
    result.filename = filename;
    result.size = st.size;
    result.rawUrl = urlPath + "?raw=1";
    result.downloadUrl = urlPath + "?download=1";
    return result;
  }

  if (ext === ".pdf") {
    result.type = "pdf";
    result.filename = filename;
    result.size = st.size;
    result.rawUrl = urlPath + "?raw=1";
    result.downloadUrl = urlPath + "?download=1";
    return result;
  }

  // Any other file type → generic download page (previously an SPA dead-end).
  result.type = "download";
  result.filename = filename;
  result.size = st.size;
  result.downloadUrl = urlPath + "?download=1";
  return result;
}

// --- Server ---

await loadVendorAssets();

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);

    // Serve vendor assets with long cache
    if (urlPath.startsWith("/_vendor/")) {
      const file = urlPath.slice("/_vendor/".length);
      const cached = vendorCache.get(file);
      if (!cached) { res.writeHead(404); res.end("Not found"); return; }

      if (req.headers["if-none-match"] === cached.etag) {
        res.writeHead(304);
        res.end();
        return;
      }

      const headers = {
        "Content-Type": cached.mime,
        "ETag": cached.etag,
        "Cache-Control": "public, max-age=31536000, immutable",
      };
      const acceptGzip = (req.headers["accept-encoding"] || "").includes("gzip");
      if (acceptGzip && cached.gzipped) {
        headers["Content-Encoding"] = "gzip";
        headers["Content-Length"] = cached.gzipped.length;
        res.writeHead(200, headers);
        res.end(cached.gzipped);
      } else {
        headers["Content-Length"] = cached.data.length;
        res.writeHead(200, headers);
        res.end(cached.data);
      }
      return;
    }

    // Content API for SPA navigation
    if (urlPath === "/_api/content") {
      const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
      const path = params.get("path") || "/";
      const data = await apiContent(path);
      const json = JSON.stringify(data);
      sendResponse(req, res, data.error ? 404 : 200, "application/json; charset=utf-8", json);
      return;
    }

    // Document routes
    const fsPath = join(ROOT, urlPath);

    // Prevent path traversal
    if (!resolve(fsPath).startsWith(ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const st = await stat(fsPath).catch(() => null);
    if (!st) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const sidebar = await getSidebar();

    if (st.isDirectory()) {
      const entries = await readdir(fsPath, { withFileTypes: true });
      const list = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      sendResponse(req, res, 200, "text/html; charset=utf-8", dirPage(urlPath, list, sidebar));
      return;
    }

    const ext = extname(fsPath).toLowerCase();
    const filename = fsPath.split("/").pop();
    const query = new URL(req.url, `http://${req.headers.host}`).searchParams;

    // Universal raw bytes / download — works for ANY file type, ahead of the
    // render branches so ?download=1 / ?raw=1 apply to markdown, code, and
    // binaries alike (not just images, as before).
    //   ?download=1 → raw bytes with Content-Disposition: attachment
    //   ?raw=1      → raw bytes inline (used by <img>/<iframe> embeds, curl, scripts)
    if (query.has("download") || query.has("raw")) {
      const data = await readFile(fsPath);
      const mime = MIME[ext] || "application/octet-stream";
      if (query.has("download")) {
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": data.length,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        });
        res.end(data);
      } else {
        sendResponse(req, res, 200, mime, data);
      }
      return;
    }

    if (ext === ".md") {
      const content = await readFile(fsPath, "utf-8");
      sendResponse(req, res, 200, "text/html; charset=utf-8", mdPage(urlPath, content, sidebar));
      return;
    }

    if (CODE_EXTENSIONS.has(ext) || guessLangFromFilename(filename)) {
      const content = await readFile(fsPath, "utf-8");
      sendResponse(req, res, 200, "text/html; charset=utf-8", codePage(urlPath, content, ext, filename, sidebar));
      return;
    }

    const accept = req.headers.accept || "";

    // PDF → browser-native viewer page (html nav) or raw application/pdf (iframe embed, curl)
    if (ext === ".pdf") {
      if (accept.includes("text/html")) {
        sendResponse(req, res, 200, "text/html; charset=utf-8", pdfPage(urlPath, filename, st.size, sidebar));
      } else {
        const data = await readFile(fsPath);
        sendResponse(req, res, 200, "application/pdf", data);
      }
      return;
    }

    // Images → wrapper page (html nav) or raw bytes (markdown <img> embeds, curl, scripts)
    if (IMAGE_EXTENSIONS.has(ext)) {
      if (accept.includes("text/html")) {
        sendResponse(req, res, 200, "text/html; charset=utf-8", imagePage(urlPath, filename, st.size, sidebar));
        return;
      }
      const data = await readFile(fsPath);
      sendResponse(req, res, 200, MIME[ext] || "application/octet-stream", data);
      return;
    }

    // Any other file type → download landing page (html nav) or raw bytes (curl/scripts).
    // Previously a bare octet-stream that broke SPA navigation on click.
    if (accept.includes("text/html")) {
      sendResponse(req, res, 200, "text/html; charset=utf-8", downloadPage(urlPath, filename, st.size, sidebar));
      return;
    }
    const mime = MIME[ext] || "application/octet-stream";
    const data = await readFile(fsPath);
    sendResponse(req, res, 200, mime, data);
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end("Internal server error");
  }
});

server.listen(PORT, ADDR, () => {
  console.log(`Atlas serving ${ROOT}`);
  console.log(`  http://${ADDR}:${PORT}`);
  console.log(`  Vendor assets: ${vendorCache.size} files cached`);
});
