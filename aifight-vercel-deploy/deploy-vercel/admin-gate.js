/*
 * AiFight admin gate — the login screen, and the thing that decides whether
 * the admin app is allowed to boot at all.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The compiled admin bundle authenticates like this:
 *
 *   configuredPassword() -> window.__AIFIGHT_CONFIG__.adminPassword
 *   isLocalUnlocked()    -> sessionStorage.getItem('aifight_local_pass_ok')==='1'
 *
 * Both halves are broken: the password came from a public file, and the gate
 * was a string in sessionStorage that any visitor could set. Rewriting that
 * properly means editing the React source, which is not in this folder — only
 * the minified output is.
 *
 * So the gate moves in front of the bundle instead of inside it. This script
 * runs before the app's module script is allowed to load. It asks the server
 * whether the caller holds a valid session cookie, and only injects the
 * application when the answer is yes.
 *
 * WHAT THIS DOES AND DOES NOT GUARANTEE
 * -------------------------------------
 * The real security boundary is the API, not this file. Every privileged
 * route — POST /api/arena, /api/settle, /api/ingest — verifies the signed
 * cookie server-side and rejects anything else, and Supabase writes are
 * governed by RLS. That is what actually protects the data.
 *
 * This gate is defence in depth and correct UX: it stops the console
 * rendering for someone who has no business seeing it. It is NOT a claim that
 * the admin UI is unreachable — a determined visitor can still make the SPA
 * router render the /admin route client-side from the home page. When they do,
 * every write they attempt fails at the server, which is the property that
 * matters.
 *
 * Replacing this with a proper `useAdminSession` hook in the React source is
 * the clean fix. See src/lib/useAdminSession.ts in the upgrade bundle.
 */
(function () {
  "use strict";

  var BOOT = document.currentScript && document.currentScript.getAttribute("data-app");
  var mount = document.getElementById("aifight-gate");
  if (!mount) return;

  /* ---------------------------------------------------------------- */
  /* Booting the real application                                      */
  /* ---------------------------------------------------------------- */

  function boot() {
    /*
     * The compiled bundle still runs its own client-side check. Setting this
     * flag satisfies it so the console renders. It is no longer a security
     * control — the server already decided, above — it is the switch that
     * tells the UI which screen to draw.
     */
    try {
      sessionStorage.setItem("aifight_local_pass_ok", "1");
    } catch (e) {
      /* private mode: the app will show its own lock screen. Harmless. */
    }

    mount.remove();

    /*
     * Reveal anything the page kept hidden behind the gate. Pages that ARE
     * the app (the logging console) mark their root `data-gated` and carry no
     * bundle to inject; pages that host the React app leave this empty and
     * get the script injection below instead.
     */
    var gated = document.querySelectorAll("[data-gated]");
    for (var i = 0; i < gated.length; i += 1) gated[i].hidden = false;

    if (!BOOT) {
      // Self-contained page: nothing to load, just tell it to start.
      document.dispatchEvent(new CustomEvent("aifight:authenticated"));
      return;
    }

    /*
     * The React console has no idea the new admin pages exist — they were
     * added to the deploy folder, not to the bundle. Without this the only
     * way to reach them is by typing the URL, which means they may as well
     * not be there. A small fixed nav is the least invasive way to surface
     * them without touching minified output.
     */
    addAdminNav();

    var script = document.createElement("script");
    script.type = "module";
    script.async = true;
    script.src = BOOT;
    document.body.appendChild(script);
  }

  /**
   * A compact link strip for the admin pages that live outside the bundle.
   *
   * Built with createElement and textContent rather than innerHTML, and
   * positioned fixed so it cannot disturb the app's layout or intercept its
   * clicks anywhere but on itself.
   */
  function addAdminNav() {
    if (document.getElementById("aifight-admin-nav")) return;

    var links = [
      { href: "/admin/console", label: "Command" },
      { href: "/admin/log", label: "Quick log" },
      { href: "/admin/prompts", label: "Prompts" },
    ];

    var nav = document.createElement("nav");
    nav.id = "aifight-admin-nav";
    nav.setAttribute("aria-label", "Admin tools");
    nav.style.cssText = [
      "position:fixed",
      "left:12px",
      "bottom:12px",
      "z-index:9998",
      "display:flex",
      "gap:6px",
      "font-family:'JetBrains Mono',ui-monospace,monospace",
      "font-size:11px",
    ].join(";");

    links.forEach(function (item) {
      var a = document.createElement("a");
      a.href = item.href;
      a.textContent = item.label;
      a.style.cssText = [
        "padding:6px 10px",
        "background:#11151d",
        "border:1px solid #2b3341",
        "border-radius:4px",
        "color:#a9b4c4",
        "text-decoration:none",
        "white-space:nowrap",
      ].join(";");
      a.addEventListener("mouseenter", function () {
        a.style.color = "#2ee6a8";
        a.style.borderColor = "#2ee6a8";
      });
      a.addEventListener("mouseleave", function () {
        a.style.color = "#a9b4c4";
        a.style.borderColor = "#2b3341";
      });
      nav.appendChild(a);
    });

    document.body.appendChild(nav);
  }

  /* ---------------------------------------------------------------- */
  /* The login screen                                                  */
  /* ---------------------------------------------------------------- */

  function render(state, detail) {
    if (state === "checking") {
      mount.innerHTML =
        '<div class="gate-card"><p class="gate-status">Verifying session…</p></div>';
      return;
    }

    if (state === "unconfigured") {
      mount.innerHTML =
        '<div class="gate-card">' +
        '<h1 class="gate-title">Server not configured</h1>' +
        '<p class="gate-copy">Admin login is disabled until these environment ' +
        "variables are set in Vercel → Settings → Environment Variables, " +
        "for Production <em>and</em> Preview:</p>" +
        '<pre class="gate-pre">' +
        (detail && detail.length ? detail.join("\n") : "ADMIN_PASSWORD_HASH\nADMIN_SESSION_SECRET") +
        "</pre>" +
        '<p class="gate-copy gate-dim">Generate both with ' +
        "<code>node scripts/hash-password.mjs</code>, then redeploy. " +
        "Do not prefix either with <code>VITE_</code>.</p>" +
        "</div>";
      return;
    }

    mount.innerHTML =
      '<form class="gate-card" id="gate-form" autocomplete="on">' +
      '<h1 class="gate-title">AiFight Admin</h1>' +
      '<p class="gate-copy gate-dim">This console can rewrite every bankroll on the site.</p>' +
      '<label class="gate-label" for="gate-pw">Password</label>' +
      '<input class="gate-input" id="gate-pw" name="password" type="password" ' +
      'autocomplete="current-password" required autofocus />' +
      '<button class="gate-button" type="submit" id="gate-submit">Unlock</button>' +
      '<p class="gate-error" id="gate-error" role="alert" aria-live="polite"></p>' +
      "</form>";

    var form = document.getElementById("gate-form");
    var input = document.getElementById("gate-pw");
    var button = document.getElementById("gate-submit");
    var error = document.getElementById("gate-error");

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      error.textContent = "";
      button.disabled = true;
      button.textContent = "Checking…";

      fetch("/api/admin/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: input.value }),
      })
        .then(function (res) {
          if (res.ok) {
            boot();
            return null;
          }
          return res.json().catch(function () {
            return {};
          });
        })
        .then(function (body) {
          if (!body) return;
          button.disabled = false;
          button.textContent = "Unlock";
          input.value = "";
          input.focus();
          error.textContent =
            body.reason === "rate-limited"
              ? "Too many attempts. Try again in " + (body.retryAfter || 60) + " seconds."
              : body.message || "Incorrect password.";
        })
        .catch(function () {
          button.disabled = false;
          button.textContent = "Unlock";
          error.textContent = "Could not reach the server.";
        });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Ask the server                                                    */
  /* ---------------------------------------------------------------- */

  render("checking");

  fetch("/api/admin/session", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  })
    .then(function (res) {
      return res.json();
    })
    .then(function (body) {
      if (body && body.authenticated) return boot();
      if (body && body.configured === false) return render("unconfigured", body.missing);
      render("login");
    })
    .catch(function () {
      /*
       * A network failure is not authentication. Fail closed: show the login
       * screen. An admin on a dropped connection is inconvenienced; the
       * alternative is booting a console whose every write would fail anyway.
       */
      render("login");
    });
})();
