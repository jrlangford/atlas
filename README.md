# Atlas

A lightweight document and code viewer with markdown rendering, mermaid diagrams, syntax highlighting, and file-tree navigation. Zero dependencies — pure Node.js, client-side rendering.

## Features

- **Markdown rendering** — reads `.md` files on each request, no build step
- **Code file viewing** — syntax-highlighted rendering for 30+ languages
- **Image view + download** — dedicated view page with filename, size, and Download button for `.png/.jpg/.jpeg/.gif/.webp/.svg/.bmp/.ico/.avif`
- **Mermaid diagrams** — flowcharts, sequence diagrams, state diagrams, etc.
- **File-tree sidebar** — collapsible, auto-expands to current page
- **Light/dark mode** — toggle with persistence
- **Directory browsing** — navigate folders with icon-based listing
- **GitHub-style theming** — familiar appearance
- **UTF-8 safe** — proper handling of multi-byte characters

## Image URLs

For any image file, three access modes are available:

| URL | Response |
|---|---|
| `/path/to/image.png` | HTML wrapper page (browser navigation) OR raw bytes (markdown `<img>` embeds, curl) — decided by `Accept` header |
| `/path/to/image.png?raw=1` | Raw bytes, regardless of `Accept` |
| `/path/to/image.png?download=1` | Raw bytes with `Content-Disposition: attachment` |

Markdown-embedded images (`![](image.png)` inside `.md` files) continue to render inline — the raw bytes are served when the request `Accept` header isn't `text/html`.

## Quick Start

```bash
node server.js /path/to/your/docs
```

Opens on `http://localhost:8881`.

## Configuration

All configuration is via environment variables:

```bash
PORT=9090 ADDRESS=0.0.0.0 node server.js /path/to/your/docs
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8881` | HTTP port |
| `ADDRESS` | `127.0.0.1` | Bind address |

## Architecture

- **Runtime:** Node.js (no dependencies)
- **Rendering:** Client-side via [marked](https://github.com/markedjs/marked), [mermaid](https://github.com/mermaid-js/mermaid), [highlight.js](https://github.com/highlightjs/highlight.js)
- **Styling:** [github-markdown-css](https://github.com/sindresorhus/github-markdown-css)
- **Server:** Single-file `server.js` using `node:http`

The server reads files on each request and serves them inside an HTML template. All rendering happens in the browser — no intermediate format, no build step. The file tree sidebar is built server-side and cached for 30 seconds.
