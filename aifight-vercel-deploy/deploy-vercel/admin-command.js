/**
 * AiFight Command — the two-column admin.
 *
 * LEFT   The Match Board. Sport tabs, sport-specific fields, and an odds
 *        matrix rendered from the server's own registry.
 * RIGHT  The Dispatcher & Settler. Pick a fixture, log all five fighters
 *        against it, then grade each position WIN / LOSS / VOID inline.
 *
 * WHY THE REGISTRY TRAVELS FROM THE SERVER
 * ----------------------------------------
 * `/api/events` returns the market definitions alongside the board, and every
 * control below is built from that payload. A hard-coded client dropdown can
 * offer a market the server then rejects — the failure lands on the admin as
 * "invalid market" with no way to know which are valid. Rendering from the
 * same source that validates makes the mismatch impossible.
 *
 * THREE MARKET SHAPES, ONE MATRIX
 * -------------------------------
 *   fixed   Home / Draw / Away, Yes / No     one odds box per outcome
 *   line    Over 2.5, Home -4.5              a line input, then two boxes
 *   roster  the drivers in a Grand Prix       name + odds per entrant
 *
 * NO POPOVERS, NO WIZARDS
 * -----------------------
 * Everything that decides a write is visible at the moment of writing: the
 * fighter's remaining budget sits above the form, the computed outcome labels
 * sit next to the odds boxes, and settlement is three buttons on the row
 * itself. A nested menu hides exactly the number the operator needed.
 */
(function () {
  "use strict";

  var state = {
    sports: [],
    sport: null,
    events: [],
    fighters: {},
    models: [],
    round: 1,
    status: "open",
    dailyLimit: 100,
    open: [],
    audit: [],
    busy: false,
  };

  var el = {};

  /* ---------------------------------------------------------------- */
  /* DOM helpers — textContent only, never innerHTML                   */
  /* ---------------------------------------------------------------- */

  function $(id) { return document.getElementById(id); }

  /**
   * Every user- and feed-supplied string reaches the DOM through here.
   *
   * This console renders team names from an odds feed and theses the operator
   * typed, under the one session on the site that can rewrite bankrolls.
   * innerHTML on either would make this page a stored-XSS sink aimed at the
   * highest-privilege user. textContent is the whole defence.
   */
  function text(v) { return document.createTextNode(v == null ? "" : String(v)); }

  function node(tag, cls, content) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (content != null) n.appendChild(text(content));
    return n;
  }

  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return "—";
    return "€" + v.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  }

  function pct(n, digits) {
    var v = Number(n);
    if (!isFinite(v)) return "—";
    return (v > 0 ? "+" : "") + v.toFixed(digits == null ? 1 : digits) + "%";
  }

  function message(kind, lines) {
    var box = node("div", "cmd-msg cmd-msg-" + kind);
    (Array.isArray(lines) ? lines : [lines]).forEach(function (line) {
      box.appendChild(node("p", null, line));
    });
    el.messages.appendChild(box);
    // Auto-clear successes; leave errors until the next action.
    if (kind === "success") setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 6000);
    return box;
  }

  function clearMessages() { clear(el.messages); }

  function audit(entry) {
    state.audit.unshift(Object.assign({ at: new Date() }, entry));
    state.audit = state.audit.slice(0, 60);
    renderAudit();
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
      if (res.status === 401) { window.location.reload(); throw new Error("session-expired"); }
      return res.json().catch(function () { return {}; })
        .then(function (body) { return { status: res.status, ok: res.ok, body: body }; });
    });
  }

  function errorsFrom(r) {
    if (r.body && Array.isArray(r.body.errors) && r.body.errors.length) return r.body.errors;
    return [(r.body && r.body.message) || "That did not work."];
  }

  /* ---------------------------------------------------------------- */
  /* Fighters                                                          */
  /* ---------------------------------------------------------------- */

  function renderFighters() {
    clear(el.fighters);
    state.models.forEach(function (name) {
      var f = state.fighters[name];
      if (!f) return;

      var bust = Number(f.current_bankroll) <= 0;
      var card = node("div", "cmd-fighter" + (bust ? " is-liquidated" : ""));

      card.appendChild(node("p", "cmd-fighter-name", name));

      var roi = ((Number(f.current_bankroll) - Number(f.starting_bankroll)) /
                 Number(f.starting_bankroll)) * 100;

      var bank = node("p", "cmd-fighter-bank", money(f.current_bankroll));
      bank.setAttribute("data-delta", roi > 0 ? "up" : roi < 0 ? "down" : "flat");
      card.appendChild(bank);

      var roiEl = node("p", "cmd-fighter-roi", pct(roi));
      roiEl.setAttribute("data-delta", roi > 0 ? "up" : roi < 0 ? "down" : "flat");
      card.appendChild(roiEl);

      var remaining = Number(f.remaining_today) || 0;
      var bar = node("div", "cmd-bar");
      var fill = node("div", "cmd-bar-fill");
      var used = state.dailyLimit > 0 ? (state.dailyLimit - remaining) / state.dailyLimit : 0;
      fill.style.width = Math.max(0, Math.min(100, used * 100)).toFixed(1) + "%";
      if (remaining <= 0) fill.classList.add("is-spent");
      bar.appendChild(fill);
      card.appendChild(bar);

      card.appendChild(node("p", "cmd-fighter-meta",
        money(remaining) + " left · " + money(f.pending) + " open"));
      card.appendChild(node("p", "cmd-fighter-record",
        f.wins + "W-" + f.losses + "L" + (f.voids ? "-" + f.voids + "V" : "")));

      // The graveyard state: a fighter that reached zero is out, and the card
      // should say so unmistakably rather than showing a quiet €0.
      if (bust) {
        card.appendChild(node("span", "cmd-stamp", "LIQUIDATED R" + state.round));
      }

      el.fighters.appendChild(card);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Round                                                             */
  /* ---------------------------------------------------------------- */

  function renderRound() {
    clear(el.round);
    el.round.appendChild(text("Round " + state.round + " · " + state.status));
    var open = state.status === "open";
    el.round.setAttribute("data-open", open ? "yes" : "no");
    el.roundOpen.hidden = open;
    el.createEvent.disabled = state.busy;
  }

  function changeRound(action, button) {
    var label = button.textContent;
    button.disabled = true; button.textContent = "…";
    api("/api/round", { method: "POST", body: JSON.stringify({ action: action }) })
      .then(function (r) {
        if (r.ok && r.body.ok) {
          state.round = r.body.round; state.status = r.body.status;
          if (r.body.fighters) state.fighters = r.body.fighters;
          renderRound(); renderFighters(); renderDispatch();
          clearMessages();
          message("success", "Round " + r.body.round + " is now " + r.body.status + ".");
          audit({ kind: "round", detail: "Round → " + r.body.round + " (" + r.body.status + ")" });
          return;
        }
        clearMessages(); message("error", errorsFrom(r));
      })
      .catch(function (e) { if (e.message !== "session-expired") message("error", "Could not reach the server."); })
      .finally(function () { button.disabled = false; button.textContent = label; });
  }

  /* ---------------------------------------------------------------- */
  /* LEFT COLUMN — the match board                                     */
  /* ---------------------------------------------------------------- */

  function currentSport() {
    return state.sports.find(function (s) { return s.key === state.sport; }) || null;
  }

  function renderSportTabs() {
    clear(el.sportTabs);
    state.sports.forEach(function (s) {
      var tab = node("button", "cmd-sport", s.label);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("data-sport", s.key);
      tab.setAttribute("aria-selected", s.key === state.sport ? "true" : "false");
      tab.addEventListener("click", function () { selectSport(s.key); });
      el.sportTabs.appendChild(tab);
    });
  }

  function selectSport(key) {
    state.sport = key;
    renderSportTabs();
    renderEventFields();
    renderMatrix();
  }

  /** Sport-specific event fields, straight from the registry. */
  function renderEventFields() {
    clear(el.eventFields);
    var sport = currentSport();
    if (!sport) return;

    sport.fields.forEach(function (field) {
      var wrap = node("div", "cmd-field");
      var label = node("label", null, field.label);
      label.setAttribute("for", "e-" + field.key);
      if (!field.required) label.appendChild(node("span", "cmd-hint", "optional"));
      wrap.appendChild(label);

      var input = document.createElement("input");
      input.type = "text";
      input.id = "e-" + field.key;
      input.setAttribute("data-field", field.key);
      input.placeholder = field.placeholder || "";
      input.autocomplete = "off";
      if (field.required) input.required = true;
      // Retyping a team name should retitle the outcome labels immediately —
      // the operator must see what will actually be stored.
      input.addEventListener("input", refreshMatrixLabels);
      wrap.appendChild(input);

      el.eventFields.appendChild(wrap);
    });
  }

  function fieldValue(key) {
    var input = el.eventFields.querySelector('[data-field="' + key + '"]');
    return input ? input.value.trim() : "";
  }

  /**
   * Substitute the registry's placeholders — the same rule the server uses.
   *
   * Kept deliberately in lockstep with `outcomesFor()` in api/_lib/sports.js.
   * If these two drift, the label the admin priced and the label the server
   * stores differ, and the duplicate check silently stops matching.
   */
  function outcomeLabels(market, ctx) {
    if (market.shape === "roster") return ctx.entrants || [];

    var home = ctx.home || "Home";
    var away = ctx.away || "Away";
    var line = ctx.line == null ? market.defaultLine : ctx.line;

    function fmt(v, signed) {
      var n = Number(v);
      if (!isFinite(n)) return "";
      var t = Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
      return signed && n > 0 ? "+" + t : t;
    }

    return (market.outcomeTemplates || []).map(function (tpl) {
      if (tpl.indexOf("{line:invert}") !== -1) {
        return tpl.replace("{line:invert}", fmt(-Number(line), true))
                  .replace("{home}", home).replace("{away}", away);
      }
      return tpl.replace("{line}", fmt(line, market.defaultLine < 0 || tpl.indexOf("{home}") !== -1))
                .replace("{home}", home).replace("{away}", away);
    });
  }

  function renderMatrix() {
    clear(el.matrix);
    var sport = currentSport();
    if (!sport) return;

    clear(el.matrixHint);
    el.matrixHint.appendChild(text("tick a market, then price every outcome"));

    sport.markets.forEach(function (market) {
      var block = node("div", "cmd-market");
      block.setAttribute("data-market", market.key);

      var head = node("div", "cmd-market-head");
      var toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.id = "m-" + market.key;
      toggle.className = "cmd-market-toggle";
      toggle.addEventListener("change", function () {
        block.classList.toggle("is-on", toggle.checked);
        body.hidden = !toggle.checked;
      });
      head.appendChild(toggle);

      var label = node("label", "cmd-market-label", market.label);
      label.setAttribute("for", toggle.id);
      head.appendChild(label);
      if (market.note) head.appendChild(node("span", "cmd-market-note", market.note));
      block.appendChild(head);

      var body = node("div", "cmd-market-body");
      body.hidden = true;

      if (market.shape === "line") {
        var lineWrap = node("div", "cmd-line");
        var lineLabel = node("label", "cmd-line-label", market.lineLabel || "Line");
        lineLabel.setAttribute("for", "line-" + market.key);
        lineWrap.appendChild(lineLabel);

        var lineInput = document.createElement("input");
        lineInput.type = "number";
        lineInput.id = "line-" + market.key;
        lineInput.className = "cmd-line-input";
        lineInput.step = String(market.lineStep || 0.5);
        lineInput.value = String(market.defaultLine);
        lineInput.setAttribute("data-line", market.key);
        lineInput.addEventListener("input", refreshMatrixLabels);
        lineWrap.appendChild(lineInput);
        body.appendChild(lineWrap);
      }

      var outcomes = node("div", "cmd-outcomes");
      outcomes.setAttribute("data-outcomes", market.key);
      body.appendChild(outcomes);

      if (market.shape === "roster") {
        var add = node("button", "cmd-add", "+ Add " + (market.entrantLabel || "entrant"));
        add.type = "button";
        add.addEventListener("click", function () {
          var max = market.maxEntrants || 30;
          if (outcomes.children.length >= max) {
            message("error", market.label + ": at most " + max + " entrants.");
            return;
          }
          outcomes.appendChild(rosterRow(market));
        });
        body.appendChild(add);
        // Two seeded rows: enough to show the shape without pre-filling junk.
        outcomes.appendChild(rosterRow(market));
        outcomes.appendChild(rosterRow(market));
      }

      block.appendChild(body);
      el.matrix.appendChild(block);
    });

    refreshMatrixLabels();
  }

  function rosterRow(market) {
    var row = node("div", "cmd-outcome cmd-outcome-roster");

    var name = document.createElement("input");
    name.type = "text";
    name.className = "cmd-entrant";
    name.placeholder = market.entrantLabel || "Entrant";
    name.setAttribute("data-entrant", "1");
    name.autocomplete = "off";
    row.appendChild(name);

    var odds = document.createElement("input");
    odds.type = "number";
    odds.className = "cmd-odds";
    odds.step = "0.01";
    odds.min = "1.01";
    odds.placeholder = "2.50";
    odds.setAttribute("data-odds", "1");
    row.appendChild(odds);

    var remove = node("button", "cmd-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove entrant");
    remove.addEventListener("click", function () { row.remove(); });
    row.appendChild(remove);

    return row;
  }

  /**
   * Repaint every computed outcome label.
   *
   * Runs on every keystroke in a team name or a line, so what the operator
   * sees beside each odds box is exactly the string that will be stored.
   */
  function refreshMatrixLabels() {
    var sport = currentSport();
    if (!sport) return;

    var ctx = { home: fieldValue("home"), away: fieldValue("away") };

    sport.markets.forEach(function (market) {
      if (market.shape === "roster") return;

      var host = el.matrix.querySelector('[data-outcomes="' + market.key + '"]');
      if (!host) return;

      var lineInput = el.matrix.querySelector('[data-line="' + market.key + '"]');
      var line = lineInput ? Number(lineInput.value) : market.defaultLine;
      var labels = outcomeLabels(market, { home: ctx.home, away: ctx.away, line: line });

      // Rebuild only when the count changes; otherwise retitle in place so a
      // half-typed odds value is never wiped by a keystroke in the team name.
      if (host.children.length !== labels.length) {
        clear(host);
        labels.forEach(function () {
          var row = node("div", "cmd-outcome");
          row.appendChild(node("span", "cmd-outcome-label", ""));
          var odds = document.createElement("input");
          odds.type = "number"; odds.className = "cmd-odds";
          odds.step = "0.01"; odds.min = "1.01"; odds.placeholder = "2.50";
          odds.setAttribute("data-odds", "1");
          row.appendChild(odds);
          host.appendChild(row);
        });
      }
      labels.forEach(function (label, i) {
        var span = host.children[i].querySelector(".cmd-outcome-label");
        clear(span); span.appendChild(text(label));
      });
    });
  }

  function collectEvent() {
    var sport = currentSport();
    var payload = { sport: sport.key, markets: [] };

    sport.fields.forEach(function (f) { payload[f.key] = fieldValue(f.key); });
    if (el.kickoff.value) payload.starts_at = new Date(el.kickoff.value).toISOString();

    sport.markets.forEach(function (market) {
      var toggle = $("m-" + market.key);
      if (!toggle || !toggle.checked) return;

      var host = el.matrix.querySelector('[data-outcomes="' + market.key + '"]');
      var entry = { key: market.key, outcomes: [] };

      var lineInput = el.matrix.querySelector('[data-line="' + market.key + '"]');
      if (lineInput) entry.line = Number(lineInput.value);

      Array.prototype.forEach.call(host.children, function (row) {
        var odds = row.querySelector("[data-odds]");
        var entrant = row.querySelector("[data-entrant]");
        if (entrant) {
          // A roster row with no name is an empty slot, not an error.
          if (!entrant.value.trim()) return;
          entry.outcomes.push({ label: entrant.value.trim(), odds: Number(odds.value) });
        } else {
          entry.outcomes.push(Number(odds.value));
        }
      });

      payload.markets.push(entry);
    });

    return payload;
  }

  function submitEvent(event) {
    event.preventDefault();
    if (state.busy) return;

    clearMessages();
    var payload = collectEvent();

    if (payload.markets.length === 0) {
      message("error", "Tick at least one market and price it.");
      return;
    }

    state.busy = true;
    el.createEvent.disabled = true;
    el.createEvent.textContent = "Adding…";

    api("/api/events", { method: "POST", body: JSON.stringify(payload) })
      .then(function (r) {
        if (r.status === 201 && r.body.ok) {
          state.events.push(Object.assign({ pickCount: 0 }, r.body.event));
          renderEvents(); renderEventSelect();
          message("success", '"' + r.body.event.name + '" added — ' +
            r.body.event.markets.length + " market" + (r.body.event.markets.length === 1 ? "" : "s") + " priced.");
          if (r.body.warnings && r.body.warnings.length) message("warn", r.body.warnings);
          audit({ kind: "event", detail: "Created " + r.body.event.name });
          resetEventForm();
          return;
        }
        message("error", errorsFrom(r));
      })
      .catch(function (e) { if (e.message !== "session-expired") message("error", "Could not reach the server."); })
      .finally(function () {
        state.busy = false;
        el.createEvent.disabled = false;
        el.createEvent.textContent = "Add to board";
      });
  }

  function resetEventForm() {
    // Reset via the prototype: a control named `reset` would shadow the method.
    HTMLFormElement.prototype.reset.call(el.eventForm);
    el.matrix.querySelectorAll(".cmd-market").forEach(function (b) { b.classList.remove("is-on"); });
    el.matrix.querySelectorAll(".cmd-market-body").forEach(function (b) { b.hidden = true; });
    renderMatrix();
    var first = el.eventFields.querySelector("input");
    if (first) first.focus();
  }

  function renderEvents() {
    clear(el.events);
    clear(el.eventCount);
    el.eventCount.appendChild(text(state.events.length ? String(state.events.length) : ""));

    if (!state.events.length) {
      el.events.appendChild(node("p", "cmd-empty", "No fixtures yet. Price one above."));
      return;
    }

    state.events.forEach(function (ev) {
      var row = node("article", "cmd-event");
      var head = node("div", "cmd-event-head");
      head.appendChild(node("span", "cmd-event-sport", ev.sport.toUpperCase()));
      head.appendChild(node("span", "cmd-event-name", ev.name));
      if (ev.pickCount) head.appendChild(node("span", "cmd-event-picks", ev.pickCount + " picks"));
      row.appendChild(head);

      var markets = node("p", "cmd-event-markets",
        ev.markets.map(function (m) { return m.label; }).join(" · "));
      row.appendChild(markets);

      var remove = node("button", "cmd-remove-event", "Remove");
      remove.type = "button";
      remove.addEventListener("click", function () { deleteEvent(ev, remove); });
      row.appendChild(remove);

      el.events.appendChild(row);
    });
  }

  function deleteEvent(ev, button) {
    button.disabled = true; button.textContent = "…";
    api("/api/events?id=" + encodeURIComponent(ev.id), { method: "DELETE" })
      .then(function (r) {
        if (r.ok && r.body.ok) {
          state.events = state.events.filter(function (e) { return e.id !== ev.id; });
          renderEvents(); renderEventSelect();
          clearMessages(); message("success", '"' + ev.name + '" removed from the board.');
          audit({ kind: "event", detail: "Removed " + ev.name });
          return;
        }
        button.disabled = false; button.textContent = "Remove";
        clearMessages(); message("error", errorsFrom(r));
      })
      .catch(function (e) {
        if (e.message !== "session-expired") {
          button.disabled = false; button.textContent = "Remove";
          message("error", "Could not reach the server.");
        }
      });
  }

  /* ---------------------------------------------------------------- */
  /* RIGHT COLUMN — dispatcher                                         */
  /* ---------------------------------------------------------------- */

  function renderEventSelect() {
    var keep = el.dEvent.value;
    clear(el.dEvent);
    var blank = document.createElement("option");
    blank.value = ""; blank.textContent = "Select a fixture…";
    el.dEvent.appendChild(blank);

    state.events.forEach(function (ev) {
      var o = document.createElement("option");
      o.value = ev.id;
      o.textContent = "[" + ev.sport.toUpperCase() + "] " + ev.name;
      el.dEvent.appendChild(o);
    });
    if (keep) el.dEvent.value = keep;
  }

  function selectedEvent() {
    return state.events.find(function (e) { return e.id === el.dEvent.value; }) || null;
  }

  /** Five rows, one per fighter, all against the selected fixture. */
  function renderDispatch() {
    clear(el.dispatch);
    var ev = selectedEvent();

    clear(el.dispatchNote);
    if (!ev) {
      el.dispatchNote.appendChild(text("Pick a fixture from the board to log all five fighters against it."));
      return;
    }
    if (state.status !== "open") {
      el.dispatchNote.appendChild(text('Round ' + state.round + ' is "' + state.status +
        '" — not accepting picks. Use Advance or Open round above.'));
      return;
    }
    el.dispatchNote.appendChild(text(ev.name + " — log each fighter, then settle below."));

    state.models.forEach(function (model) {
      var f = state.fighters[model] || {};
      var row = node("div", "cmd-dispatch-row");
      row.setAttribute("data-model", model);

      var head = node("div", "cmd-dispatch-head");
      head.appendChild(node("span", "cmd-dispatch-model", model));
      head.appendChild(node("span", "cmd-dispatch-budget",
        money(f.remaining_today) + " left · " + money(f.current_bankroll)));
      row.appendChild(head);

      var grid = node("div", "cmd-dispatch-grid");

      // Market → selection are linked: choosing a market repopulates the
      // selection list with only that market's priced outcomes, so an
      // impossible pairing cannot be submitted.
      var market = document.createElement("select");
      market.className = "cmd-select"; market.setAttribute("data-role", "market");
      ev.markets.forEach(function (m) {
        var o = document.createElement("option");
        o.value = m.key; o.textContent = m.label;
        market.appendChild(o);
      });
      grid.appendChild(market);

      var selection = document.createElement("select");
      selection.className = "cmd-select"; selection.setAttribute("data-role", "selection");
      grid.appendChild(selection);

      function fillSelections() {
        clear(selection);
        var m = ev.markets.find(function (x) { return x.key === market.value; });
        (m ? m.outcomes : []).forEach(function (o) {
          var opt = document.createElement("option");
          opt.value = o.label;
          // The price rides along, so the row knows the odds without a lookup.
          opt.setAttribute("data-odds", String(o.odds));
          opt.textContent = o.label + "  @ " + Number(o.odds).toFixed(2);
          selection.appendChild(opt);
        });
      }
      market.addEventListener("change", fillSelections);
      fillSelections();

      var stake = document.createElement("input");
      stake.type = "number"; stake.className = "cmd-input"; stake.placeholder = "Stake €";
      stake.min = "1"; stake.step = "1"; stake.setAttribute("data-role", "stake");
      grid.appendChild(stake);

      var prob = document.createElement("input");
      prob.type = "number"; prob.className = "cmd-input"; prob.placeholder = "Prob %";
      prob.min = "0"; prob.max = "100"; prob.step = "0.1"; prob.setAttribute("data-role", "prob");
      grid.appendChild(prob);

      row.appendChild(grid);

      var thesis = document.createElement("textarea");
      thesis.className = "cmd-thesis"; thesis.rows = 2;
      thesis.placeholder = "Thesis — published to the public rationale drawer (required)";
      thesis.setAttribute("data-role", "thesis");
      row.appendChild(thesis);

      var actions = node("div", "cmd-dispatch-actions");
      var ev_ = node("span", "cmd-ev", "");
      ev_.setAttribute("data-role", "ev");
      actions.appendChild(ev_);

      var log = node("button", "cmd-log", "Log " + model);
      log.type = "button";
      log.addEventListener("click", function () { logPick(ev, model, row, log); });
      actions.appendChild(log);
      row.appendChild(actions);

      // Live EV from the selected price and the typed probability.
      function updateEv() {
        var opt = selection.options[selection.selectedIndex];
        var odds = opt ? Number(opt.getAttribute("data-odds")) : NaN;
        var p = Number(prob.value) / 100;
        clear(ev_);
        if (!isFinite(odds) || !isFinite(p) || p <= 0 || p >= 1) { ev_.removeAttribute("data-delta"); return; }
        var value = (p * (odds - 1) - (1 - p)) * 100;
        ev_.setAttribute("data-delta", value > 0 ? "up" : "down");
        ev_.appendChild(text("EV " + pct(value) + " · break-even " + (100 / odds).toFixed(1) + "%"));
      }
      prob.addEventListener("input", updateEv);
      selection.addEventListener("change", updateEv);
      market.addEventListener("change", updateEv);

      el.dispatch.appendChild(row);
    });
  }

  function logPick(ev, model, row, button) {
    var market = row.querySelector('[data-role="market"]');
    var selection = row.querySelector('[data-role="selection"]');
    var stake = row.querySelector('[data-role="stake"]');
    var prob = row.querySelector('[data-role="prob"]');
    var thesis = row.querySelector('[data-role="thesis"]');

    var opt = selection.options[selection.selectedIndex];
    if (!opt) { message("error", "That market has no priced outcomes."); return; }

    var payload = {
      model: model,
      event: ev.name,
      market: market.value,
      pick: opt.value,
      // The price comes from the board, never retyped — a transcription slip
      // cannot move a bankroll.
      odds: Number(opt.getAttribute("data-odds")),
      stake: Number(stake.value),
      fair_prob: prob.value === "" ? null : Number(prob.value),
      reasoning: thesis.value.trim(),
      event_id: ev.id,
    };

    clearMessages();
    var problems = [];
    if (!(payload.stake > 0)) problems.push(model + ": stake must be greater than zero.");
    if (!payload.reasoning) problems.push(model + ": a thesis is required — it is what the public drawer shows.");
    else if (payload.reasoning.length < 20) problems.push(model + ": thesis is too short.");
    if (problems.length) { message("error", problems); return; }

    button.disabled = true; button.textContent = "Logging…";

    api("/api/picks", { method: "POST", body: JSON.stringify(payload) })
      .then(function (r) {
        if (r.status === 201 && r.body.ok) {
          if (r.body.fighters) state.fighters = r.body.fighters;
          state.open.unshift(r.body.bet);
          renderFighters(); renderOpen();
          message("success", model + " · " + payload.pick + " @ " +
            payload.odds.toFixed(2) + " · " + money(payload.stake) + " staked.");
          if (r.body.warnings && r.body.warnings.length) message("warn", r.body.warnings);
          audit({ kind: "pick", detail: model + " → " + payload.pick + " " + money(payload.stake) });
          stake.value = ""; prob.value = ""; thesis.value = "";
          clear(row.querySelector('[data-role="ev"]'));
          var e = state.events.find(function (x) { return x.id === ev.id; });
          if (e) { e.pickCount = (e.pickCount || 0) + 1; renderEvents(); }
          return;
        }
        message("error", errorsFrom(r));
      })
      .catch(function (e) { if (e.message !== "session-expired") message("error", "Could not reach the server."); })
      .finally(function () { button.disabled = false; button.textContent = "Log " + model; });
  }

  /* ---------------------------------------------------------------- */
  /* Settler                                                           */
  /* ---------------------------------------------------------------- */

  function renderOpen() {
    clear(el.open);
    clear(el.openCount);
    el.openCount.appendChild(text(state.open.length ? String(state.open.length) : ""));

    if (!state.open.length) {
      el.open.appendChild(node("p", "cmd-empty", "None."));
      return;
    }

    state.open.forEach(function (bet) {
      var row = node("div", "cmd-position");
      var head = node("div", "cmd-position-head");
      head.appendChild(node("span", "cmd-position-model", bet.model));
      head.appendChild(node("span", "cmd-position-id", "#" + bet.id));
      head.appendChild(node("span", "cmd-position-line",
        bet.pick + " @ " + Number(bet.odds).toFixed(2) + " · " + money(bet.stake)));
      row.appendChild(head);
      row.appendChild(node("p", "cmd-position-event", bet.event));

      // What each button will pay, computed before it is pressed.
      var win = Math.round(bet.stake * (bet.odds - 1) * 100) / 100;
      var buttons = node("div", "cmd-settle");
      [
        { result: "win", label: "WIN", hint: "+" + money(win) },
        { result: "loss", label: "LOSS", hint: "−" + money(bet.stake) },
        { result: "void", label: "VOID", hint: "refund" },
      ].forEach(function (action) {
        var b = node("button", "cmd-settle-btn cmd-settle-" + action.result);
        b.type = "button";
        b.appendChild(node("span", "cmd-settle-label", action.label));
        b.appendChild(node("span", "cmd-settle-hint", action.hint));
        b.addEventListener("click", function () { settle(bet, action.result, row); });
        buttons.appendChild(b);
      });
      row.appendChild(buttons);

      el.open.appendChild(row);
    });
  }

  function settle(bet, result, row) {
    row.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    clearMessages();

    api("/api/picks", { method: "PATCH", body: JSON.stringify({ id: bet.id, result: result }) })
      .then(function (r) {
        if (r.ok && r.body.ok) {
          if (r.body.fighters) state.fighters = r.body.fighters;
          state.open = state.open.filter(function (b) { return b.id !== bet.id; });
          renderFighters(); renderOpen();

          var s = r.body.settlement;
          message("success", [
            bet.model + " · " + bet.pick + " → " + result.toUpperCase(),
            "Payout " + money(s.payout) + " · " +
              (s.profit === 0 ? "stake refunded" : (s.profit > 0 ? "+" : "−") + money(Math.abs(s.profit))) +
              " · bankroll " + money(r.body.fighter.current_bankroll),
          ]);
          audit({
            kind: "settle",
            detail: bet.model + " #" + bet.id + " " + result.toUpperCase() +
              " → " + money(r.body.fighter.current_bankroll),
          });
          return;
        }
        row.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
        message("error", errorsFrom(r));
      })
      .catch(function (e) {
        row.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
        if (e.message !== "session-expired") message("error", "Could not reach the server.");
      });
  }

  function renderAudit() {
    clear(el.audit);
    clear(el.auditCount);
    el.auditCount.appendChild(text(state.audit.length ? String(state.audit.length) : ""));

    if (!state.audit.length) {
      el.audit.appendChild(node("p", "cmd-empty", "Nothing yet this session."));
      return;
    }
    state.audit.forEach(function (entry) {
      var row = node("div", "cmd-audit-row");
      row.appendChild(node("span", "cmd-audit-time",
        entry.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })));
      row.appendChild(node("span", "cmd-audit-kind", entry.kind));
      row.appendChild(node("span", "cmd-audit-detail", entry.detail));
      el.audit.appendChild(row);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  function loadAll() {
    return Promise.all([api("/api/picks"), api("/api/events")]).then(function (results) {
      var picks = results[0].body, board = results[1].body;

      if (picks.ok) {
        state.models = picks.models || [];
        state.fighters = picks.fighters || {};
        state.round = picks.round || 1;
        state.status = picks.status || "open";
        state.dailyLimit = picks.dailyLimit || 100;
        state.open = (picks.recent || []).filter(function (b) {
          return (b.result || "pending") === "pending";
        });
        if (picks.integrity) {
          clear(el.integrity);
          var ok = picks.integrity.ok !== false;
          el.integrity.className = "cmd-integrity " + (ok ? "is-ok" : "is-broken");
          el.integrity.appendChild(text(ok ? "chain verified" : "chain broken"));
        }
      }

      if (board.ok) {
        state.sports = board.sports || [];
        state.events = board.events || [];
        if (!state.sport && state.sports.length) state.sport = state.sports[0].key;
      }

      renderRound(); renderFighters();
      renderSportTabs(); renderEventFields(); renderMatrix();
      renderEvents(); renderEventSelect(); renderDispatch();
      renderOpen(); renderAudit();
    });
  }

  function start() {
    el = {
      messages: $("messages"), fighters: $("fighters"),
      round: $("round-badge"), roundOpen: $("round-open"), roundAdvance: $("round-advance"),
      logout: $("logout"), integrity: $("integrity"),
      sportTabs: $("sport-tabs"), eventForm: $("event-form"), eventFields: $("event-fields"),
      kickoff: $("e-kickoff"), matrix: $("matrix"), matrixHint: $("matrix-hint"),
      createEvent: $("create-event"), clearEvent: $("clear-event"),
      events: $("events"), eventCount: $("event-count"),
      dEvent: $("d-event"), dispatch: $("dispatch"), dispatchNote: $("dispatch-note"),
      open: $("open"), openCount: $("open-count"),
      audit: $("audit"), auditCount: $("audit-count"),
    };

    el.eventForm.addEventListener("submit", submitEvent);
    el.clearEvent.addEventListener("click", function () { clearMessages(); resetEventForm(); });
    el.dEvent.addEventListener("change", renderDispatch);
    el.roundOpen.addEventListener("click", function () { changeRound("open", el.roundOpen); });
    el.roundAdvance.addEventListener("click", function () { changeRound("advance", el.roundAdvance); });
    el.logout.addEventListener("click", function () {
      api("/api/admin/session", { method: "POST" }).finally(function () { window.location.href = "/admin"; });
    });

    loadAll().catch(function (e) {
      if (e.message !== "session-expired") message("error", e.message || "Could not load the arena.");
    });
  }

  document.addEventListener("aifight:authenticated", start);
})();
