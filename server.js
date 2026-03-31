import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, join, resolve, relative } from "node:path";

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const ROOT_NAME = basename(ROOT);
const PORT = parseInt(process.env.PORT || "8881", 10);
const ADDR = process.env.ADDRESS || "127.0.0.1";

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

// Extensions rendered as syntax-highlighted code pages (instead of download)
const CODE_EXTENSIONS = new Set([
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

// Recursively build file tree as HTML
async function buildTree(dir, urlBase) {
  const entries = await readdir(dir, { withFileTypes: true });
  const sorted = entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => {
      const aDir = a.isDirectory();
      const bDir = b.isDirectory();
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  let html = "<ul>";
  for (const entry of sorted) {
    const href = urlBase + entry.name + (entry.isDirectory() ? "/" : "");
    if (entry.isDirectory()) {
      const children = await buildTree(join(dir, entry.name), href);
      html += `<li class="tree-dir"><span class="tree-toggle" onclick="this.parentElement.classList.toggle('open')">📁 ${entry.name}</span>${children}</li>`;
    } else if (entry.name.endsWith(".md") || CODE_EXTENSIONS.has(extname(entry.name).toLowerCase()) || entry.name.toLowerCase() === "dockerfile" || entry.name.toLowerCase() === "makefile" || entry.name.toLowerCase() === "justfile") {
      html += `<li class="tree-file"><a href="${href}">📄 ${entry.name}</a></li>`;
    }
  }
  html += "</ul>";
  return html;
}

const PAGE_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{TITLE}}</title>
  <link id="md-css-dark" rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown-dark.min.css">
  <link id="md-css-light" rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown-light.min.css" disabled>
  <link id="hljs-css-dark" rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github-dark.min.css">
  <link id="hljs-css-light" rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css" disabled>
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
    .theme-toggle, .collapse-btn { cursor: pointer; background: none; border: 1px solid #444; border-radius: 6px; padding: 2px 8px; font-size: 14px; line-height: 1; }
    body.dark .theme-toggle, body.dark .collapse-btn { border-color: #444; color: #e6edf3; }
    body.light .theme-toggle, body.light .collapse-btn { border-color: #ccc; color: #1f2328; }

    /* Expand button (visible when sidebar is collapsed) */
    .expand-btn { position: fixed; top: 12px; left: 12px; z-index: 11; cursor: pointer; background: none; border: 1px solid; border-radius: 6px; padding: 4px 10px; font-size: 16px; line-height: 1; transition: opacity 0.2s; }
    .expand-btn.hidden { opacity: 0; pointer-events: none; }
    body.dark .expand-btn { border-color: #444; background: #010409; color: #e6edf3; }
    body.light .expand-btn { border-color: #ccc; background: #f6f8fa; color: #1f2328; }

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
    .top-bar { max-width: 980px; margin: 0 auto 12px; padding: 0 24px; font-size: 14px; }
    .breadcrumb { flex: 1; }
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
      .expand-btn { opacity: 1; pointer-events: auto; }
      .expand-btn.hidden { opacity: 1; pointer-events: auto; }
    }
    /* Pre-paint sidebar collapse (prevents flash on page load) */
    html[data-sidebar="collapsed"] .sidebar { transform: translateX(-280px); }
    html[data-sidebar="collapsed"] .main { margin-left: 0; width: 100%; }
    html[data-sidebar="collapsed"] .expand-btn { opacity: 1; pointer-events: auto; }

    .mermaid .node rect, .mermaid .node polygon, .mermaid .node circle, .mermaid .node .label-container { overflow: visible; }
    .mermaid svg { overflow: visible; }
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
  <button class="expand-btn hidden" id="expand-btn" onclick="toggleSidebar()" title="Show sidebar">☰</button>
  <div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleSidebar()"></div>
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title"><a href="/">${ROOT_NAME}</a></span>
      <button class="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode">🌓</button>
      <button class="collapse-btn" onclick="toggleSidebar()" title="Hide sidebar">◀</button>
    </div>
    {{SIDEBAR}}
  </aside>
  <div class="main">
    <div class="top-bar">
      <nav class="breadcrumb">{{BREADCRUMB}}</nav>
    </div>
    <article class="markdown-body">{{CONTENT}}</article>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>
    function isMobile() { return window.innerWidth <= 768; }
    function toggleSidebar() {
      var sb = document.getElementById('sidebar');
      var main = document.querySelector('.main');
      var btn = document.getElementById('expand-btn');
      var overlay = document.getElementById('sidebar-overlay');

      if (isMobile()) {
        // Mobile: overlay mode — main content stays full width
        var isOpen = sb.classList.toggle('open-mobile');
        overlay.classList.toggle('visible', isOpen);
      } else {
        // Desktop: push mode
        var collapsed = sb.classList.toggle('collapsed');
        main.classList.toggle('expanded', collapsed);
        btn.classList.toggle('hidden', !collapsed);
        localStorage.setItem('mdview-sidebar', collapsed ? 'collapsed' : 'open');
      }
    }
    (function() {
      if (!isMobile() && localStorage.getItem('mdview-sidebar') === 'collapsed') {
        document.getElementById('sidebar').classList.add('collapsed');
        document.querySelector('.main').classList.add('expanded');
        document.getElementById('expand-btn').classList.remove('hidden');
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

    // Auto-expand sidebar tree to show current page
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
            start: function(src) { return src.match(/\`\`\`mermaid/)?.index; },
            tokenizer: function(src) {
              var match = src.match(/^\`\`\`mermaid\\n([\\s\\S]*?)\`\`\`/);
              if (match) {
                return { type: 'mermaidBlock', raw: match[0], text: match[1].trim() };
              }
            },
            renderer: function(token) {
              return '<pre class="mermaid">' + token.text + '</pre>';
            }
          }]
        };

        marked.use(mermaidExt);
        marked.use({ gfm: true, breaks: false });

        document.querySelector('.markdown-body').innerHTML = marked.parse(md);

        document.querySelectorAll('pre code').forEach(function(el) { hljs.highlightElement(el); });
        mermaid.run({ nodes: document.querySelectorAll('.mermaid') });
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
      const icon = e.isDir ? "📁" : "📄";
      const href = urlPath.replace(/\/?$/, "/") + e.name + (e.isDir ? "/" : "");
      return `<li><span class="icon">${icon}</span><a href="${href}">${e.name}${e.isDir ? "/" : ""}</a></li>`;
    })
    .join("\n");

  const content = `<h1>${urlPath === "/" ? ROOT_NAME : urlPath}</h1>\n<ul class="dir-listing">\n${items}\n</ul>`;
  return PAGE_TEMPLATE
    .replace("{{TITLE}}", urlPath)
    .replace("{{SIDEBAR}}", sidebar)
    .replace("{{BREADCRUMB}}", breadcrumb(urlPath))
    .replace("{{CONTENT}}", content);
}

function mdPage(urlPath, markdown, sidebar) {
  const b64 = Buffer.from(markdown, "utf-8").toString("base64");
  const content = `<div id="raw-markdown" data-content="${b64}"></div>`;
  return PAGE_TEMPLATE
    .replace("{{TITLE}}", urlPath)
    .replace("{{SIDEBAR}}", sidebar)
    .replace("{{BREADCRUMB}}", breadcrumb(urlPath))
    .replace("{{CONTENT}}", content);
}

// Map file extensions to highlight.js language identifiers
const EXT_TO_LANG = {
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

function codePage(urlPath, code, ext, filename, sidebar) {
  const lang = EXT_TO_LANG[ext] || guessLangFromFilename(filename) || "plaintext";
  const b64 = Buffer.from(code, "utf-8").toString("base64");
  const content = `<div id="raw-code" data-content="${b64}" data-lang="${lang}"></div>`;
  return PAGE_TEMPLATE
    .replace("{{TITLE}}", urlPath)
    .replace("{{SIDEBAR}}", sidebar)
    .replace("{{BREADCRUMB}}", breadcrumb(urlPath))
    .replace("{{CONTENT}}", content);
}

function guessLangFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  if (lower === "justfile") return "makefile";
  return null;
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

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dirPage(urlPath, list, sidebar));
      return;
    }

    const ext = extname(fsPath).toLowerCase();
    const filename = fsPath.split("/").pop();
    if (ext === ".md") {
      const content = await readFile(fsPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(mdPage(urlPath, content, sidebar));
      return;
    }

    if (CODE_EXTENSIONS.has(ext) || guessLangFromFilename(filename)) {
      const content = await readFile(fsPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(codePage(urlPath, content, ext, filename, sidebar));
      return;
    }

    // Serve static files as-is
    const mime = MIME[ext] || "application/octet-stream";
    const data = await readFile(fsPath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end("Internal server error");
  }
});

server.listen(PORT, ADDR, () => {
  console.log(`Markdown viewer serving ${ROOT}`);
  console.log(`  http://${ADDR}:${PORT}`);
});
