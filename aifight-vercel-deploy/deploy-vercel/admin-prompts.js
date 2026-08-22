/**
 * The persona prompt browser.
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * The five personas live in `src/lib/personas.ts`, which is TypeScript in a
 * repo this deploy folder does not contain. Without a build step there is no
 * way to `import` them, so they would be a file you could read but not use.
 *
 * `admin-personas.js` is that module compiled to a browser global by esbuild,
 * generated FROM the TypeScript rather than retyped — so the prompts here and
 * the prompts in the repo cannot drift. This page renders them with a copy
 * button and a link to each model.
 *
 * The model↔persona mapping is a per-round decision, not a fixed pairing.
 * Nothing here assumes Claude is always the Quant; the five prompts are five
 * roles, and which fighter takes which role is yours to set.
 */
(function () {
  "use strict";

  /** Where each fighter is used, for the "open the model" link. */
  var MODEL_URLS = {
    Claude: "https://claude.ai/new",
    Grok: "https://x.com/i/grok",
    ChatGPT: "https://chatgpt.com/",
    Gemini: "https://gemini.google.com/app",
    Kimi: "https://kimi.com/",
  };

  /**
   * The suggested pairing. Deliberately a SUGGESTION, printed as a note
   * rather than enforced — a season where Grok runs the Quant book and Claude
   * runs the Contrarian one is a legitimate experiment, and hard-coding the
   * mapping would quietly prevent it.
   */
  var SUGGESTED = {
    quant: "Gemini",
    sharp: "ChatGPT",
    tactician: "Claude",
    situational: "Kimi",
    contrarian: "Grok",
  };

  var data = null;
  var current = null;
  var el = {};

  function $(id) {
    return document.getElementById(id);
  }

  function setText(node, value) {
    while (node.firstChild) node.removeChild(node.firstChild);
    node.appendChild(document.createTextNode(value == null ? "" : String(value)));
  }

  /**
   * Copy to clipboard with a real fallback.
   *
   * `navigator.clipboard` requires a secure context and is absent on plain
   * HTTP and in some embedded browsers. A copy button that silently does
   * nothing on a preview deployment is worse than no button, so the
   * execCommand path stays.
   */
  function copy(textValue, button, label) {
    var done = function () {
      var original = label;
      button.classList.add("is-done");
      setText(button, "Copied");
      setTimeout(function () {
        button.classList.remove("is-done");
        setText(button, original);
      }, 1600);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(textValue).then(done, function () {
        fallback(textValue, done);
      });
      return;
    }
    fallback(textValue, done);
  }

  function fallback(textValue, done) {
    var area = document.createElement("textarea");
    area.value = textValue;
    // Off-screen rather than display:none — a hidden element cannot be
    // selected, so the copy would silently fail.
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      done();
    } catch (e) {
      window.prompt("Copy this prompt:", textValue);
    }
    document.body.removeChild(area);
  }

  function select(id) {
    current = id;
    var persona = data.personas[id];
    if (!persona) return;

    document.querySelectorAll(".pp-tab").forEach(function (tab) {
      var active = tab.getAttribute("data-persona") === id;
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.style.setProperty("--accent", persona.accent);
    });

    setText(el.handle, persona.handle);
    el.handle.style.color = persona.accent;
    setText(el.role, persona.discipline);
    setText(el.tagline, persona.tagline);
    setText(el.prompt, data.promptFor(id));

    var suggested = SUGGESTED[id];
    setText(
      el.note,
      "Suggested fighter: " +
        suggested +
        ". The pairing is a starting point, not a rule — swap roles between seasons and the leaderboard still compares like for like, because all five get the same board.",
    );

    el.open.href = MODEL_URLS[suggested] || "#";
    setText(el.open, "Open " + suggested + " ↗");
  }

  function start() {
    data = window.__AIFIGHT_PERSONAS__;

    el = {
      tabs: document.querySelector(".pp-tabs"),
      handle: $("pp-handle"),
      role: $("pp-role"),
      tagline: $("pp-tagline"),
      prompt: $("pp-prompt"),
      note: $("pp-note"),
      copy: $("pp-copy"),
      copyContract: $("pp-copy-contract"),
      open: $("pp-open"),
    };

    if (!data || !data.order) {
      setText(el.prompt, "Could not load the personas. /admin-personas.js is missing from the deploy.");
      return;
    }

    data.order.forEach(function (id, index) {
      var persona = data.personas[id];
      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "pp-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("data-persona", id);
      tab.setAttribute("aria-selected", index === 0 ? "true" : "false");
      tab.appendChild(document.createTextNode(persona.handle));
      tab.addEventListener("click", function () {
        select(id);
      });
      el.tabs.appendChild(tab);
    });

    // Arrow-key navigation between tabs, which is what `role="tablist"`
    // promises assistive tech and what a keyboard user will try.
    el.tabs.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      var index = data.order.indexOf(current);
      var next = event.key === "ArrowRight" ? index + 1 : index - 1;
      if (next < 0) next = data.order.length - 1;
      if (next >= data.order.length) next = 0;
      select(data.order[next]);
      el.tabs.children[next].focus();
      event.preventDefault();
    });

    el.copy.addEventListener("click", function () {
      copy(data.promptFor(current), el.copy, "Copy full prompt");
    });
    el.copyContract.addEventListener("click", function () {
      copy(data.contract, el.copyContract, "Copy schema contract only");
    });

    select(data.order[0]);
  }

  document.addEventListener("aifight:authenticated", start);
})();
