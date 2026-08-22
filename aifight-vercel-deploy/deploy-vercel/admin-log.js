/**
 * The manual pick-logging console.
 *
 * WHY IT IS PLAIN JAVASCRIPT
 * --------------------------
 * The React source for this site is not in the deploy folder — only the
 * minified bundle. Adding a form to the existing admin console would mean
 * patching minified output, which is fragile in a way that has already bitten
 * this project once. This page is self-contained instead: no framework, no
 * build step, no dependency on the bundle's internals. It talks to
 * `/api/picks`, which enforces every rule server-side.
 *
 * THE DIVISION OF RESPONSIBILITY
 * ------------------------------
 * The server is the authority. It validates, checks the budget, refuses
 * duplicates, extends the hash chain and recomputes every fighter. This file
 * never decides whether a pick is legal — it only makes the answer arrive
 * fast and read clearly.
 *
 * Client-side checks exist purely to save a round trip on obvious mistakes.
 * They are advisory, they are never the last word, and disabling them in
 * devtools achieves nothing because the server re-runs all of it.
 *
 * ZERO-ERROR SUBMIT
 * -----------------
 * Three failure modes are designed out rather than handled:
 *
 *   double submit    the button disables for the whole request, and an
 *                    in-flight flag rejects a second call even if the
 *                    disable is bypassed
 *   stale budget     fighters are updated from the POST response itself, so
 *                    the displayed remaining budget is never a refetch behind
 *   silent failure   every response path writes a visible message; there is
 *                    no branch that ends quietly
 */
(function () {
  "use strict";

  var state = {
    models: [],
    fighters: {},
    round: 1,
    status: "open",
    dailyLimit: 100,
    board: [],
    boardByRef: Object.create(null),
    recent: [],
    thesis: null,
    canLog: true,
    submitting: false,
  };

  var el = {};

  /* ---------------------------------------------------------------- */
  /* Utilities                                                         */
  /* ---------------------------------------------------------------- */

  function $(id) {
    return document.getElementById(id);
  }

  /**
   * Everything user-supplied goes through here before it touches the DOM.
   *
   * The console displays a thesis the admin typed and a fixture name from an
   * upstream feed. Using innerHTML on either would make this page a stored-XSS
   * sink — against the one session on the site that can rewrite bankrolls.
   * textContent is the whole defence and it is not optional.
   */
  function text(value) {
    return document.createTextNode(value == null ? "" : String(value));
  }

  function node(tag, className, content) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (content != null) n.appendChild(text(content));
    return n;
  }

  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return "—";
    return "€" + v.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  }

  function clearMessages() {
    while (el.messages.firstChild) el.messages.removeChild(el.messages.firstChild);
  }

  function message(kind, lines) {
    var box = node("div", "lc-msg lc-msg-" + kind);
    var list = Array.isArray(lines) ? lines : [lines];
    for (var i = 0; i < list.length; i += 1) {
      box.appendChild(node("p", null, list[i]));
    }
    el.messages.appendChild(box);
    return box;
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * The fighter strip: bankroll, remaining budget, open exposure.
   *
   * Rebuilt from `state.fighters` on every change. The selected fighter is
   * highlighted, so the number the admin is spending against is the one their
   * eye is already on.
   */
  function renderFighters() {
    var host = el.fighters;
    while (host.firstChild) host.removeChild(host.firstChild);

    var selected = el.model.value;

    state.models.forEach(function (name) {
      var f = state.fighters[name];
      if (!f) return;

      var card = node("div", "lc-fighter" + (name === selected ? " is-selected" : ""));
      card.setAttribute("data-model", name);

      card.appendChild(node("p", "lc-fighter-name", name));

      var bankroll = node("p", "lc-fighter-bankroll", money(f.current_bankroll));
      var delta = Number(f.profit) || 0;
      bankroll.setAttribute("data-delta", delta > 0 ? "up" : delta < 0 ? "down" : "flat");
      card.appendChild(bankroll);

      var remaining = Number(f.remaining_today) || 0;
      var bar = node("div", "lc-bar");
      var fill = node("div", "lc-bar-fill");
      var used = state.dailyLimit > 0 ? (state.dailyLimit - remaining) / state.dailyLimit : 0;
      fill.style.width = Math.max(0, Math.min(100, used * 100)).toFixed(1) + "%";
      if (remaining <= 0) fill.classList.add("is-spent");
      bar.appendChild(fill);
      card.appendChild(bar);

      card.appendChild(
        node("p", "lc-fighter-meta", money(remaining) + " left today · " + money(f.pending) + " open"),
      );
      card.appendChild(
        node("p", "lc-fighter-record", f.wins + "W-" + f.losses + "L" + (f.voids ? "-" + f.voids + "V" : "")),
      );

      // Clicking a card selects that fighter — faster than the dropdown.
      card.addEventListener("click", function () {
        el.model.value = name;
        onFighterChange();
      });

      host.appendChild(card);
    });
  }

  function renderRecent() {
    var host = el.recent;
    while (host.firstChild) host.removeChild(host.firstChild);

    if (!state.recent.length) {
      host.appendChild(node("p", "lc-empty", "No picks logged yet."));
      return;
    }

    state.recent.forEach(function (bet) {
      var row = node("article", "lc-bet");
      row.setAttribute("data-result", bet.result || "pending");

      var head = node("div", "lc-bet-head");
      head.appendChild(node("span", "lc-bet-model", bet.model));
      head.appendChild(node("span", "lc-bet-id", "#" + bet.id));
      head.appendChild(node("span", "lc-bet-result " + (bet.result || "pending"), bet.result || "pending"));
      row.appendChild(head);

      row.appendChild(node("p", "lc-bet-event", bet.event));
      row.appendChild(
        node(
          "p",
          "lc-bet-line",
          bet.pick + " @ " + Number(bet.odds).toFixed(2) + " · " + money(bet.stake),
        ),
      );

      if (bet.reasoning) {
        var thesis = node("p", "lc-bet-thesis", bet.reasoning);
        row.appendChild(thesis);
      }

      // Only a pending pick can be removed. A settled one has already moved
      // the bankroll and must be voided through settlement instead.
      if ((bet.result || "pending") === "pending") {
        var remove = node("button", "lc-bet-remove", "Remove");
        remove.type = "button";
        remove.setAttribute("aria-label", "Remove pick " + bet.id);
        remove.addEventListener("click", function () {
          removePick(bet.id, remove);
        });
        row.appendChild(remove);
      }

      host.appendChild(row);
    });
  }

  /**
   * Render /api/diagnose.
   *
   * Each finding is a measured reason the public board shows what it shows,
   * with the fix stated. This panel exists because "the picks aren't showing"
   * was attributed to joins, nested markets and status filters in turn — none
   * of which were the cause. A number beats a hypothesis.
   */
  function renderDiagnosis(body) {
    var host = el.diagnosis;
    while (host.firstChild) host.removeChild(host.firstChild);

    var findings = (body && body.findings) || [];
    // A clean bill of health does not need permanent screen space.
    var worth = findings.filter(function (f) { return f.severity !== "ok"; });
    if (!worth.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;

    worth.forEach(function (f) {
      var card = node("div", "lc-finding");
      card.setAttribute("data-sev", f.severity);

      var head = node("div", "lc-finding-head");
      head.appendChild(node("span", "lc-finding-sev", f.severity));
      head.appendChild(node("span", "lc-finding-title", f.title));
      if (body.activeSource) {
        head.appendChild(node("span", "lc-source", "source: " + body.activeSource));
      }
      card.appendChild(head);

      if (f.detail) card.appendChild(node("p", "lc-finding-detail", f.detail));
      if (f.fix) {
        var fix = node("p", "lc-finding-fix");
        fix.appendChild(node("b", null, "Fix: "));
        fix.appendChild(text(f.fix));
        card.appendChild(fix);
      }
      host.appendChild(card);
    });
  }

  function loadDiagnosis() {
    return api("/api/diagnose")
      .then(function (r) {
        if (r.ok) renderDiagnosis(r.body);
      })
      .catch(function () {
        /* Diagnostics are advisory — never block the form on them. */
      });
  }

  /* ---------------------------------------------------------------- */
  /* Round control                                                     */
  /* ---------------------------------------------------------------- */

  function renderRound() {
    while (el.round.firstChild) el.round.removeChild(el.round.firstChild);
    el.round.appendChild(text("Round " + state.round + " · " + state.status));

    var open = state.status === "open";
    el.round.style.color = open ? "var(--lc-profit)" : "var(--lc-warn)";
    el.round.style.borderColor = open ? "var(--lc-profit)" : "var(--lc-warn)";

    // Only offer "Open round" when it would change something.
    el.roundOpen.hidden = open;
    state.canLog = open;
    el.submit.disabled = !open || state.submitting;
  }

  function changeRound(action, button) {
    var label = button.textContent;
    button.disabled = true;
    button.textContent = "Working…";

    api("/api/round", { method: "POST", body: JSON.stringify({ action: action }) })
      .then(function (r) {
        if (r.ok && r.body.ok) {
          state.round = r.body.round;
          state.status = r.body.status;
          if (r.body.fighters) state.fighters = r.body.fighters;
          renderRound();
          renderFighters();
          updateStakeHint();
          clearMessages();

          var lines = ["Round " + r.body.round + " is now " + r.body.status + "."];
          if (r.body.statusMeaning) lines.push(r.body.statusMeaning);
          if (r.body.advanceWarning) lines.push(r.body.advanceWarning);
          message(r.body.status === "open" ? "success" : "warn", lines);

          // The reason the board was empty may have just changed.
          loadDiagnosis();
          return;
        }
        clearMessages();
        message("error", (r.body && r.body.errors) || [r.body.message || "Could not change the round."]);
      })
      .catch(function (err) {
        if (err && err.message === "session-expired") return;
        message("error", "Could not reach the server.");
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = label;
      });
  }

  function renderBoard() {
    var select = el.ref;
    while (select.options.length > 1) select.remove(1);

    if (!state.board.length) return;

    var currentEvent = null;
    var group = null;

    state.board.forEach(function (entry) {
      if (entry.event !== currentEvent) {
        currentEvent = entry.event;
        group = document.createElement("optgroup");
        group.label = entry.event + "  ·  " + (entry.kickoffLocal || "");
        select.appendChild(group);
      }
      var option = document.createElement("option");
      option.value = String(entry.ref);
      option.textContent =
        "[" + entry.ref + "] " + entry.marketLabel + " — " + entry.pick + " @ " + entry.odds.toFixed(2);
      // A fixture that has kicked off cannot be staked on.
      if (!entry.bettable) {
        option.disabled = true;
        option.textContent += "  (in play / finished)";
      }
      (group || select).appendChild(option);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Derived readouts                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Read the probability field the way the server does.
   *
   * A value above 1 is unambiguously a percentage — a probability cannot
   * exceed 1 — so dividing by 100 is a repair, not a guess. Mirrors
   * `validatePick` exactly so the preview never disagrees with the result.
   */
  function readProbability(raw) {
    var n = Number(raw);
    if (!isFinite(n) || raw === "" || raw == null) return null;
    if (n > 1 && n <= 100) return n / 100;
    if (n > 0 && n < 1) return n;
    return null;
  }

  function updateEv() {
    var odds = Number(el.odds.value);
    var prob = readProbability(el.prob.value);

    if (!isFinite(odds) || odds <= 1 || prob == null) {
      el.ev.hidden = true;
      return;
    }

    var ev = (prob * (odds - 1) - (1 - prob)) * 100;
    var breakEven = (1 / odds) * 100;

    el.ev.hidden = false;
    el.ev.setAttribute("data-delta", ev > 0 ? "up" : ev < 0 ? "down" : "flat");
    while (el.ev.firstChild) el.ev.removeChild(el.ev.firstChild);
    el.ev.appendChild(
      text(
        "EV " +
          (ev > 0 ? "+" : "") +
          ev.toFixed(1) +
          "%  ·  break-even " +
          breakEven.toFixed(1) +
          "%  ·  your " +
          (prob * 100).toFixed(1) +
          "%",
      ),
    );
  }

  function updateStakeHint() {
    var f = state.fighters[el.model.value];
    while (el.stakeHint.firstChild) el.stakeHint.removeChild(el.stakeHint.firstChild);
    if (!f) return;
    el.stakeHint.appendChild(text(money(f.remaining_today) + " left"));
    // A soft cap: the server is what actually enforces it.
    el.stake.max = String(Math.max(1, Math.floor(f.remaining_today)));
  }

  function onFighterChange() {
    renderFighters();
    updateStakeHint();
  }

  /* ---------------------------------------------------------------- */
  /* Board reference → form                                            */
  /* ---------------------------------------------------------------- */

  function onRefChange() {
    var ref = el.ref.value;
    if (!ref) {
      // Back to manual entry: unlock the fields, leave what was typed.
      setDerivedReadonly(false);
      return;
    }

    var entry = state.boardByRef[ref];
    if (!entry) return;

    el.event.value = entry.event;
    el.market.value = entry.market;
    el.pick.value = entry.pick;
    el.odds.value = String(entry.odds);

    /*
     * The de-vigged market probability is offered as a STARTING POINT, never
     * silently committed. Leaving the admin's own number alone matters: the
     * whole point of the arena is the gap between a model's probability and
     * the market's, and overwriting a typed value with the market's would
     * quietly erase the thing being measured.
     */
    if (entry.marketProb != null && !el.prob.value) {
      el.prob.placeholder = "market " + entry.marketProb.toFixed(3);
    }

    setDerivedReadonly(true);
    updateEv();
  }

  /**
   * Lock the fields the board filled in.
   *
   * readOnly rather than disabled: a disabled input is excluded from the form
   * and drops out of the tab order, and both would be wrong here — the values
   * still submit and a keyboard user should still be able to reach them.
   */
  function setDerivedReadonly(locked) {
    [el.event, el.market, el.pick, el.odds].forEach(function (input) {
      input.readOnly = locked;
      input.classList.toggle("is-derived", locked);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Network                                                           */
  /* ---------------------------------------------------------------- */

  function api(path, options) {
    var init = options || {};
    init.credentials = "same-origin";
    init.cache = "no-store";
    init.headers = init.headers || {};
    if (init.body) init.headers["Content-Type"] = "application/json";
    return fetch(path, init).then(function (res) {
      // A lapsed session mid-edit must not look like a validation failure.
      if (res.status === 401) {
        window.location.reload();
        throw new Error("session-expired");
      }
      return res.json().catch(function () {
        return {};
      }).then(function (body) {
        return { status: res.status, ok: res.ok, body: body };
      });
    });
  }

  function loadState() {
    return api("/api/picks").then(function (r) {
      if (!r.ok) throw new Error(r.body.message || "Could not load the arena.");
      applyState(r.body);
    });
  }

  function applyState(body) {
    if (body.models) state.models = body.models;
    if (body.fighters) state.fighters = body.fighters;
    if (typeof body.round === "number") state.round = body.round;
    if (body.status) state.status = body.status;
    if (typeof body.dailyLimit === "number") state.dailyLimit = body.dailyLimit;
    if (body.recent) state.recent = body.recent;

    // Fighter dropdown, populated once from the server's list.
    if (el.model.options.length <= 1) {
      state.models.forEach(function (name) {
        var option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        el.model.appendChild(option);
      });
    }

    renderRound();

    if (body.thesis) {
      state.thesis = body.thesis;
    }

    if (body.integrity) {
      while (el.integrity.firstChild) el.integrity.removeChild(el.integrity.firstChild);
      var ok = body.integrity.ok !== false;
      el.integrity.className = "lc-integrity " + (ok ? "is-ok" : "is-broken");
      el.integrity.appendChild(text(ok ? "chain verified" : "chain broken at #" + body.integrity.brokenAt));
    }

    /*
     * Any non-open round is closed server-side. Reflecting that here turns a
     * guaranteed 409 into a disabled button plus a one-click way out, which is
     * the difference between a bug report and an understood constraint.
     */
    if (state.status !== "open") {
      clearMessages();
      message("warn", [
        "Round " + state.round + " is \"" + state.status + "\" — not accepting new picks.",
        "Use Advance round to start the next one, or Open round to reopen this one.",
      ]);
    }

    renderFighters();
    renderRecent();
    updateStakeHint();

    /*
     * Coverage is reported, not buried. Picks logged before this route
     * existed may have no thesis, and each one is a bet card on the live site
     * with no explanation — the admin should know the count rather than
     * discover it from a visitor.
     */
    if (state.thesis && state.thesis.missing > 0) {
      message("warn", [
        state.thesis.missing +
          " of " +
          state.thesis.total +
          " logged picks have no thesis (" +
          state.thesis.percent +
          "% covered).",
        "Those show no rationale drawer on the public site. Pick ids: " +
          state.thesis.missingIds.join(", "),
      ]);
    }
  }

  function loadBoard() {
    return api("/api/board").then(function (r) {
      var body = r.body || {};
      state.board = Array.isArray(body.entries) ? body.entries : [];
      state.boardByRef = Object.create(null);
      state.board.forEach(function (entry) {
        state.boardByRef[String(entry.ref)] = entry;
      });

      while (el.boardStatus.firstChild) el.boardStatus.removeChild(el.boardStatus.firstChild);
      if (state.board.length) {
        el.boardStatus.appendChild(text(state.board.length + " outcomes"));
      } else {
        el.boardStatus.appendChild(text(body.message || "no board — enter manually"));
      }

      renderBoard();
    }).catch(function () {
      // The board is a convenience. Losing it must not block manual logging.
      while (el.boardStatus.firstChild) el.boardStatus.removeChild(el.boardStatus.firstChild);
      el.boardStatus.appendChild(text("unavailable — enter manually"));
    });
  }

  /* ---------------------------------------------------------------- */
  /* Submit                                                            */
  /* ---------------------------------------------------------------- */

  function collect() {
    return {
      model: el.model.value,
      event: el.event.value.trim(),
      market: el.market.value.trim(),
      pick: el.pick.value.trim(),
      odds: el.odds.value,
      stake: el.stake.value,
      fair_prob: el.prob.value,
      reasoning: el.reasoning.value.trim(),
      risk_factors: el.risk.value.trim(),
      confidence: el.confidence.value,
      ref: el.ref.value || null,
    };
  }

  /** Obvious mistakes only. The server re-checks everything. */
  function preflight(payload) {
    var problems = [];
    if (!payload.model) problems.push("Choose a fighter.");
    if (!payload.event) problems.push("Event is required.");
    if (!payload.market) problems.push("Market is required.");
    if (!payload.pick) problems.push("Selection is required.");
    if (!(Number(payload.odds) > 1)) problems.push("Odds must be greater than 1.00.");
    if (!(Number(payload.stake) > 0)) problems.push("Stake must be greater than zero.");
    /*
     * The thesis is what the public rationale drawer publishes. The compiled
     * bundle gates both the drawer and the inline "Quant breakdown" expander
     * on `bet.reasoning &&`, so a pick without one renders to visitors as a
     * card with no explanation and no way to open one.
     */
    if (!payload.reasoning) {
      problems.push("Thesis is required — it is what the public rationale drawer shows.");
    } else if (payload.reasoning.length < 20) {
      problems.push("Thesis is too short. Say what the edge is and what would make it wrong.");
    }
    return problems;
  }

  function submit(event) {
    event.preventDefault();

    // Belt and braces against a double submit: the button is disabled below,
    // and this flag catches the case where that disable is bypassed.
    if (state.submitting) return;

    clearMessages();

    var payload = collect();
    var problems = preflight(payload);
    if (problems.length) {
      message("error", problems);
      return;
    }

    state.submitting = true;
    el.submit.disabled = true;
    el.submit.textContent = "Logging…";

    api("/api/picks", { method: "POST", body: JSON.stringify(payload) })
      .then(function (r) {
        if (r.status === 201 && r.body.ok) {
          onLogged(r.body);
          return;
        }

        if (r.body && Array.isArray(r.body.errors) && r.body.errors.length) {
          message("error", r.body.errors);
        } else {
          message("error", r.body.message || "Could not log the pick. Nothing was written.");
        }

        // A conflict means our view of the arena is behind. Resync so the next
        // attempt is judged against what is actually stored.
        if (r.status === 409) loadState();
      })
      .catch(function (err) {
        if (err && err.message === "session-expired") return;

        /*
         * Distinguish "the network failed" from "our code threw".
         *
         * Reporting a TypeError as "could not reach the server" is how the
         * form-reset bug above stayed hidden: the pick HAD been written, the
         * success message was already on screen, and the user was told the
         * server was unreachable. A programming error must name itself so it
         * gets fixed instead of being read as a flaky connection.
         */
        var isNetwork = err instanceof TypeError && /fetch|network|load failed/i.test(err.message || "");
        if (isNetwork) {
          message("error", "Could not reach the server. Nothing was written.");
        } else {
          message("error", [
            "The pick may have been saved, but the console hit an internal error.",
            String((err && err.message) || err),
            "Reload to see the current state before logging it again.",
          ]);
          if (window.console && console.error) console.error("[aifight/log]", err);
        }
      })
      .finally(function () {
        state.submitting = false;
        el.submit.disabled = !state.canLog;
        el.submit.textContent = "Log Pick";
      });
  }

  /**
   * Apply a successful log.
   *
   * Fighters come from the POST response, not a refetch — the server already
   * computed them inside the same transaction that wrote the bet, so this is
   * both faster and strictly more correct than asking again.
   */
  function onLogged(body) {
    if (body.fighters) state.fighters = body.fighters;
    if (body.bet) state.recent.unshift(body.bet);
    state.recent = state.recent.slice(0, 25);

    renderFighters();
    renderRecent();
    updateStakeHint();

    var f = body.fighter;
    var summary =
      body.bet.model +
      " · " +
      body.bet.pick +
      " @ " +
      Number(body.bet.odds).toFixed(2) +
      " · " +
      money(body.bet.stake) +
      " staked";

    var lines = [summary];
    if (f) {
      lines.push(
        "Bankroll " + money(f.current_bankroll) + " · " + money(f.remaining_today) + " left today",
      );
    }
    message("success", lines);

    if (Array.isArray(body.warnings) && body.warnings.length) {
      message("warn", body.warnings);
    }

    resetForm({ keepFighter: true });
  }

  /**
   * Clear the form for the next pick.
   *
   * The fighter is kept by default. Logging five picks for one model is the
   * common case, and resetting the dropdown every time makes the admin
   * re-select it five times — the sort of small friction that pushes people
   * back to pasting text.
   */
  function resetForm(options) {
    var keepFighter = options && options.keepFighter;
    var fighter = el.model.value;

    /*
     * Reset via the prototype, not `el.form.reset()`.
     *
     * A form exposes its named controls as properties on itself, and that
     * lookup SHADOWS same-named methods. A `<button id="reset">` inside this
     * form therefore made `form.reset` the button element, and calling it
     * threw "form.reset is not a function" — swallowed by the promise chain
     * in submit(), so the form silently stopped clearing after every log
     * while still reporting success.
     *
     * The button has been renamed, and this call is immune to it happening
     * again with any future control named `reset`, `submit`, `elements`…
     */
    HTMLFormElement.prototype.reset.call(el.form);
    el.ref.value = "";
    setDerivedReadonly(false);
    el.prob.placeholder = "0.55";
    el.ev.hidden = true;
    el.reasoningCount.textContent = "0";

    if (keepFighter && fighter) el.model.value = fighter;

    onFighterChange();
    el.event.focus();
  }

  function removePick(id, button) {
    button.disabled = true;
    button.textContent = "Removing…";

    api("/api/picks?id=" + encodeURIComponent(id), { method: "DELETE" })
      .then(function (r) {
        if (r.ok && r.body.ok) {
          if (r.body.fighters) state.fighters = r.body.fighters;
          state.recent = state.recent.filter(function (b) {
            return Number(b.id) !== Number(id);
          });
          renderFighters();
          renderRecent();
          updateStakeHint();
          clearMessages();
          message("success", "Pick #" + id + " removed. Budget restored.");
          return;
        }
        button.disabled = false;
        button.textContent = "Remove";
        clearMessages();
        message(
          "error",
          (r.body && r.body.errors) || [r.body.message || "Could not remove that pick."],
        );
      })
      .catch(function (err) {
        if (err && err.message === "session-expired") return;
        button.disabled = false;
        button.textContent = "Remove";
        message("error", "Could not reach the server.");
      });
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  function start() {
    el = {
      form: $("pick-form"),
      model: $("f-model"),
      ref: $("f-ref"),
      event: $("f-event"),
      market: $("f-market"),
      pick: $("f-pick"),
      odds: $("f-odds"),
      stake: $("f-stake"),
      prob: $("f-prob"),
      reasoning: $("f-reasoning"),
      risk: $("f-risk"),
      confidence: $("f-confidence"),
      submit: $("submit"),
      clear: $("clear-form"),
      messages: $("messages"),
      fighters: $("fighters"),
      recent: $("recent"),
      round: $("round-badge"),
      integrity: $("integrity"),
      boardStatus: $("board-status"),
      stakeHint: $("stake-hint"),
      ev: $("ev-readout"),
      reasoningCount: $("reasoning-count"),
      logout: $("logout"),
      diagnosis: $("diagnosis"),
      roundOpen: $("round-open"),
      roundAdvance: $("round-advance"),
    };

    el.form.addEventListener("submit", submit);
    el.model.addEventListener("change", onFighterChange);
    el.ref.addEventListener("change", onRefChange);
    el.odds.addEventListener("input", updateEv);
    el.prob.addEventListener("input", updateEv);
    el.reasoning.addEventListener("input", function () {
      el.reasoningCount.textContent = String(el.reasoning.value.length);
    });
    el.clear.addEventListener("click", function (event) {
      event.preventDefault();
      clearMessages();
      resetForm({ keepFighter: false });
    });
    el.roundOpen.addEventListener("click", function () {
      changeRound("open", el.roundOpen);
    });
    el.roundAdvance.addEventListener("click", function () {
      changeRound("advance", el.roundAdvance);
    });
    el.logout.addEventListener("click", function () {
      api("/api/admin/session", { method: "POST" }).finally(function () {
        window.location.href = "/admin";
      });
    });

    // Cmd/Ctrl+Enter submits from anywhere in the form — the shortcut anyone
    // logging twenty picks in a row will reach for.
    el.form.addEventListener("keydown", function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        el.form.requestSubmit();
      }
    });

    loadState()
      .then(loadBoard)
      .then(loadDiagnosis)
      .catch(function (err) {
        if (err && err.message === "session-expired") return;
        message("error", err.message || "Could not load the arena.");
      });
  }

  // The gate fires this once the server has confirmed a session.
  document.addEventListener("aifight:authenticated", start);
})();
