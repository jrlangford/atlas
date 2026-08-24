/*
 * atlas-math — LaTeX math rendering for Atlas, as a marked extension + KaTeX.
 *
 * Why a separate file (not inline in server.js): the render paths in server.js
 * live inside a template literal, where a `$`/`${...}` math regex collides with
 * template interpolation. Keeping the math logic here means normal escaping and
 * a clean home for the first of several planned content-format extensions.
 *
 * Design: intercept math at marked TOKENIZE time (not post-DOM auto-render) so
 * marked's inline rules never mangle the TeX (underscores→emphasis, dropped
 * backslashes, etc.). The renderer emits a placeholder carrying the raw TeX as
 * escaped text; AtlasMath.render() then runs KaTeX over those placeholders.
 * Math inside code/pre/fenced blocks is never touched: fenced code is
 * block-tokenized first, and inline code spans are consumed by marked's
 * codespan rule before this inline tokenizer sees the '$'.
 *
 * Delimiters: $$...$$ (display, may span lines) and $...$ (inline, single line).
 * Inline requires no whitespace just inside the delimiters, which rejects the
 * common currency false-positive ("$5 and $10"). Caveat: adjacent no-space
 * currency like "$5+$10" can still be read as math — write real inline math and
 * escape literal dollar amounts as needed.
 */
(function () {
  "use strict";

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function placeholder(tex, display) {
    var tag = display ? "div" : "span";
    return (
      "<" + tag + ' class="katex-src" data-display="' + (display ? "1" : "0") + '">' +
      esc(tex) +
      "</" + tag + ">"
    );
  }

  var ext = {
    extensions: [
      {
        // Display math: $$ ... $$  (block level, tried before inline; may span lines)
        name: "blockKatex",
        level: "block",
        start: function (src) {
          var i = src.indexOf("$$");
          return i < 0 ? undefined : i;
        },
        tokenizer: function (src) {
          var m = src.match(/^\$\$([\s\S]+?)\$\$/);
          if (m) return { type: "blockKatex", raw: m[0], text: m[1].trim() };
        },
        renderer: function (t) {
          return placeholder(t.text, true);
        },
      },
      {
        // Inline math: $ ... $  (single line; no whitespace adjacent to delimiters)
        name: "inlineKatex",
        level: "inline",
        start: function (src) {
          var i = src.search(/\$(?!\$)/);
          return i < 0 ? undefined : i;
        },
        tokenizer: function (src) {
          // Exclude backtick from the content so an unpaired literal '$' (e.g.
          // currency "$10") can't reach across into a '$' inside an inline code
          // span and swallow it. Content is also single-line and '$'-free.
          var m = src.match(/^\$(?!\s)((?:[^$\n`])+?)(?<!\s)\$/);
          if (m) return { type: "inlineKatex", raw: m[0], text: m[1].trim() };
        },
        renderer: function (t) {
          return placeholder(t.text, false);
        },
      },
    ],
  };

  function render(root) {
    if (!root || typeof katex === "undefined") return;
    root.querySelectorAll(".katex-src").forEach(function (el) {
      try {
        katex.render(el.textContent, el, {
          displayMode: el.dataset.display === "1",
          throwOnError: false,
        });
        el.classList.remove("katex-src");
      } catch (e) {
        // Leave the TeX source visible rather than blanking the node.
      }
    });
  }

  window.AtlasMath = { ext: ext, render: render };
})();
