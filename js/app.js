/* SPR Block 0 — routing, gating, progress store, rendering.
   Vanilla JS, no dependencies. Answer checking (check.js) is not wired in the shell. */
(function () {
  "use strict";

  var ROOT = document.body.getAttribute("data-root") || ".";
  var PAGE = document.body.getAttribute("data-page");
  var STORE_KEY = "spr-block0-progress";

  /* ---------- progress store: localStorage with in-memory fallback ---------- */
  var memory = null;
  var storageOK = true;

  function blank() { return { version: 1, studentName: "", lessons: {}, synthesis: {} }; }

  function load() {
    if (memory) return memory;
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      memory = raw ? JSON.parse(raw) : blank();
    } catch (e) { storageOK = false; memory = blank(); }
    return memory;
  }
  function save() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(memory)); }
    catch (e) { storageOK = false; }
  }
  function lessonState(id) {
    var p = load();
    if (!p.lessons[id]) p.lessons[id] = { answers: {}, passed: false, attempts: 0, passedAt: null };
    return p.lessons[id];
  }

  function exportProgress() {
    var p = load();
    var name = (p.studentName || "student").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    var blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "spr-progress-" + name + ".json";
    document.body.appendChild(a); a.click(); a.remove();
  }
  function importProgress(file, done) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var data = JSON.parse(r.result);
        if (!data || typeof data.lessons !== "object") throw new Error("bad file");
        memory = data; save(); done(null);
      } catch (e) { done(e); }
    };
    r.readAsText(file);
  }

  /* ---------- helpers ---------- */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function fmtDate(iso) {
    var d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  function today() { var d = new Date(); return d.toISOString().slice(0, 10); }

  /* ---------- gating ---------- */
  function status(content, idx) {
    var L = content.lessons[idx];
    var st = lessonState(L.id);
    if (st.passed) return { key: "passed", label: "Passed" };
    if (content.preview) return { key: "open", label: "Open" };
    if (L.opensAt > today()) return { key: "locked", label: "Opens " + fmtDate(L.opensAt) };
    if (idx > 0 && !lessonState(content.lessons[idx - 1].id).passed)
      return { key: "locked", label: "Locked" };
    return { key: "open", label: "Open" };
  }

  /* ---------- shared chrome ---------- */
  function chrome(content) {
    var c = content.course;
    document.querySelectorAll("[data-course-code]").forEach(function (n) { n.textContent = c.code; });
    document.querySelectorAll("[data-course-title]").forEach(function (n) { n.textContent = c.title; });
    var foot = document.querySelector("[data-instructors]");
    if (foot) foot.textContent = c.instructors.join(" · ");
    if (content.preview) {
      var b = el("div", { class: "banner", role: "status" }, [
        el("div", { class: "wrap" }, [
          el("strong", { text: "Preview" }),
          el("span", { text: "Instructor review build. All lessons unlocked; answers are not checked; nothing here is final." })
        ])
      ]);
      document.body.insertBefore(b, document.body.firstChild);
    }
    if (!storageOK) {
      var main = document.querySelector("main");
      main.insertBefore(el("p", { class: "storage-warn", text: "This browser is not saving progress (private browsing or a locked-down machine). Your work will be lost when you close the tab unless you use Export progress." }), main.firstChild);
    }
  }

  /* ---------- landing ---------- */
  function renderIndex(content) {
    var c = content.course;
    var set = function (sel, txt) { var n = document.querySelector(sel); if (n) n.textContent = txt; };
    set("[data-due]", fmtDate(c.certificateDue));
    set("[data-unit1]", fmtDate(c.unit1));
    set("[data-term]", c.term);

    var passed = content.lessons.filter(function (L) { return lessonState(L.id).passed; }).length;
    var total = content.lessons.length;
    document.querySelector(".progress-bar > span").style.width = (100 * passed / total) + "%";
    set("[data-progress]", passed + " of " + total + " lessons passed");

    var fl = 0, ll = 0;
    content.lessons.forEach(function (L) { fl += L.minutes[0]; ll += L.minutes[1]; });
    set("[data-total-time]", "About " + fl + " min if fluent, " + (ll / 60).toFixed(1) + " h if looking things up");

    var host = document.getElementById("lessons");
    var halves = {};
    content.lessons.forEach(function (L, i) { (halves[L.opensAt] = halves[L.opensAt] || []).push(i); });
    Object.keys(halves).sort().forEach(function (date, h) {
      var idxs = halves[date];
      host.appendChild(el("div", { class: "half-label" }, [
        el("span", { text: (h === 0 ? "First half" : "Second half") + " · Lessons " + content.lessons[idxs[0]].id.replace(/^0/, "") + "–" + content.lessons[idxs[idxs.length - 1]].id.replace(/^0/, "") }),
        el("span", { text: "Opens " + fmtDate(date) })
      ]));
      var ul = el("ul", { class: "lesson-list" });
      idxs.forEach(function (i) {
        var L = content.lessons[i], s = status(content, i);
        var inner = [
          el("span", { class: "lesson-num", text: L.id }),
          el("span", null, [el("div", { class: "lesson-title", text: L.title }), el("div", { class: "lesson-sub", text: L.sub })]),
          el("span", { class: "lesson-time", text: L.minutes[0] + " / " + L.minutes[1] + " min" }),
          el("span", { class: "status " + s.key, text: s.label })
        ];
        var row = s.key === "locked"
          ? el("div", { class: "lesson-row locked", "aria-disabled": "true" }, inner)
          : el("a", { class: "lesson-row", href: "lessons/" + L.slug + ".html" }, inner);
        ul.appendChild(el("li", null, [row]));
      });
      host.appendChild(ul);
    });

    var first = content.lessons.findIndex(function (L, i) { return status(content, i).key === "open"; });
    var start = document.getElementById("start");
    if (first >= 0) { start.href = "lessons/" + content.lessons[first].slug + ".html"; start.textContent = passed ? "Continue" : "Start Lesson 1"; }
    else start.setAttribute("aria-disabled", "true");

    wireProgressButtons();
  }

  function wireProgressButtons() {
    var ex = document.getElementById("export"), im = document.getElementById("import"), file = document.getElementById("import-file");
    if (ex) ex.addEventListener("click", exportProgress);
    if (im && file) {
      im.addEventListener("click", function () { file.click(); });
      file.addEventListener("change", function () {
        if (!file.files[0]) return;
        importProgress(file.files[0], function (err) {
          alert(err ? "That file could not be read as SPR progress." : "Progress imported.");
          if (!err) location.reload();
        });
      });
    }
  }

  /* ---------- lesson ---------- */
  function renderLesson(content) {
    var id = document.body.getAttribute("data-lesson");
    var idx = content.lessons.findIndex(function (L) { return L.id === id; });
    var L = content.lessons[idx];
    var st = lessonState(id);
    var s = status(content, idx);
    document.title = "Lesson " + Number(L.id) + ": " + L.title + " · " + content.course.code;

    var main = document.querySelector("main");
    main.appendChild(el("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, [
      el("a", { href: ROOT + "/index.html", text: "Block 0" }), " / Lesson " + Number(L.id)
    ]));
    main.appendChild(el("header", { class: "lesson-head" }, [
      el("div", null, [el("p", { class: "eyebrow", text: "Lesson " + Number(L.id) + " of " + content.lessons.length }), el("h1", { text: L.title })]),
      el("div", { class: "lesson-meta" }, [
        el("span", { text: L.minutes[0] + " min fluent · " + L.minutes[1] + " min learning" }),
        el("span", { text: L.input }),
        el("span", { text: "Status: " + s.label })
      ])
    ]));

    if (s.key === "locked") {
      main.appendChild(el("div", { class: "locked-panel" }, [
        el("h2", { text: "This lesson is locked" }),
        el("p", { text: L.opensAt > today() ? "It opens " + fmtDate(L.opensAt) + "." : "Pass the previous lesson to open it." }),
        el("a", { class: "btn", href: ROOT + "/index.html", text: "Back to lessons" })
      ]));
      return;
    }

    var left = el("div");
    var framing = el("section", { class: "framing" });
    L.framing.forEach(function (p) { framing.appendChild(el("p", { text: p })); });
    left.appendChild(framing);

    var work = el("section", { class: "work", "aria-labelledby": "work-h" });
    var required = L.cells.filter(function (c) { return !c.optional; }).length;
    work.appendChild(el("div", { class: "work-head" }, [
      el("h2", { id: "work-h", text: "Your answers" }),
      el("span", { class: "work-count", text: L.cells.length ? required + " required" : "" })
    ]));

    if (!L.cells.length) {
      work.appendChild(el("div", { class: "locked-panel" }, [el("p", { class: "muted", text: "Items for this lesson are not drafted yet." })]));
    } else {
      var selects = L.cells.filter(function (c) { return c.type === "select"; });
      var mcs = L.cells.filter(function (c) { return c.type === "mc"; });
      if (selects.length) work.appendChild(selectTable(selects, st));
      mcs.forEach(function (c, i) { work.appendChild(mcItem(c, i + 1, st)); });

      var result = el("span", { class: "result", role: "status", "aria-live": "polite", text: "Answers save automatically." });
      var btn = el("button", { class: "btn primary", type: "button", text: "Check answers" });
      btn.addEventListener("click", function () {
        var missing = L.cells.filter(function (c) { return !c.optional && !st.answers[c.id]; }).length;
        if (missing) { result.className = "result bad"; result.textContent = missing + (missing === 1 ? " item is" : " items are") + " still blank."; return; }
        result.className = "result";
        result.textContent = content.preview ? "Preview build: answer checking is not wired yet." : "Checking…";
      });
      work.appendChild(el("div", { class: "check-bar" }, [result, btn]));
    }
    left.appendChild(work);

    var where = el("aside", { class: "where", "aria-labelledby": "where-h" }, [el("h2", { id: "where-h", text: "Where to look" })]);
    var ul = el("ul");
    L.where.forEach(function (w) {
      ul.appendChild(el("li", null, [w.url ? el("a", { href: w.url, target: "_blank", rel: "noopener", text: w.label }) : document.createTextNode(w.label)]));
    });
    if (!L.where.length) ul.appendChild(el("li", { class: "muted", text: "To be added." }));
    where.appendChild(ul);
    where.appendChild(el("p", { class: "src-note", text: "A wrong answer is marked, never revealed. After three misses on the same item, its specific reference appears beside it." }));

    main.appendChild(el("div", { class: "lesson-grid" }, [left, where]));

    var prev = content.lessons[idx - 1], next = content.lessons[idx + 1];
    main.appendChild(el("nav", { class: "pager", "aria-label": "Lesson navigation" }, [
      prev ? el("a", { href: prev.slug + ".html", text: "← " + prev.title }) : el("span"),
      next ? el("a", { href: next.slug + ".html", text: next.title + " →" }) : el("a", { href: ROOT + "/certificate.html", text: "Certificate →" })
    ]));
  }

  function selectTable(cells, st) {
    var tbody = el("tbody");
    cells.forEach(function (c) {
      var sel = el("select", { id: "f-" + c.id, "aria-label": c.prompt });
      sel.appendChild(el("option", { value: "", text: "Choose…" }));
      c.options.forEach(function (o) {
        var opt = el("option", { value: o, text: o });
        if (st.answers[c.id] === o) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", function () { st.answers[c.id] = sel.value; save(); });
      tbody.appendChild(el("tr", { "data-cell": c.id }, [
        el("td", null, [el("label", { for: "f-" + c.id, text: c.prompt }), c.optional ? el("span", { class: "optional-tag", text: "Optional" }) : null]),
        el("td", { class: "answer" }, [sel]),
        el("td", { class: "mark" }, [el("span", { class: "mark-text" })])
      ]));
    });
    return el("table", { class: "cell-table" }, [
      el("thead", null, [el("tr", null, [el("th", { text: "Item" }), el("th", { text: "Answer" }), el("th", { text: "" })])]),
      tbody
    ]);
  }

  function mcItem(c, n, st) {
    var opts = el("div", { class: "opts" });
    c.options.forEach(function (o, i) {
      var input = el("input", { type: "radio", name: c.id, value: o, id: c.id + "-" + i });
      if (st.answers[c.id] === o) input.checked = true;
      input.addEventListener("change", function () { st.answers[c.id] = o; save(); });
      opts.appendChild(el("label", { for: c.id + "-" + i }, [input, el("span", { text: o })]));
    });
    return el("fieldset", { class: "mc", "data-cell": c.id }, [
      el("legend", null, [el("span", { class: "qnum", text: n + "." }), c.prompt, c.draft ? el("span", { class: "optional-tag", text: "Draft item" }) : null]),
      opts,
      el("span", { class: "mark-text" })
    ]);
  }

  /* ---------- boot ---------- */
  load();
  fetch(ROOT + "/data/content.json", { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (content) {
      chrome(content);
      if (PAGE === "index") renderIndex(content);
      else if (PAGE === "lesson") renderLesson(content);
      else wireProgressButtons();
    })
    .catch(function () {
      var main = document.querySelector("main");
      main.insertBefore(el("p", { class: "storage-warn", text: "Course content could not be loaded. If you opened this file directly from your computer, use the course link instead." }), main.firstChild);
    });
})();
