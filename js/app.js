/* SPR Block 0 — routing, gating, progress store, rendering, answer checking.
   Vanilla JS, no dependencies. Hashing lives in check.js. */
(function () {
  "use strict";

  var ROOT = document.body.getAttribute("data-root") || ".";
  var PAGE = document.body.getAttribute("data-page");
  var STORE_KEY = "spr-block0-progress";
  var MISSES_FOR_REF = 3;

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
    var s = p.lessons[id] || (p.lessons[id] = {});
    s.answers = s.answers || {};
    s.misses = s.misses || {};
    s.attempts = s.attempts || 0;
    if (s.passed === undefined) { s.passed = false; s.passedAt = null; }
    return s;
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
  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  function safeId(s) { return "f-" + s.replace(/[^a-z0-9]+/gi, "-"); }

  /* Stable per-student shuffle: each lesson gets a random seed once, so the order is
     different between students but does not jump around on reload. */
  function seededShuffle(arr, seedStr) {
    var h = 2166136261;
    for (var i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
    var rnd = function () { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
    var a = arr.slice();
    for (var j = a.length - 1; j > 0; j--) { var k = Math.floor(rnd() * (j + 1)); var t = a[j]; a[j] = a[k]; a[k] = t; }
    return a;
  }
  function lessonSeed(st) {
    if (!st.seed) { st.seed = Math.random().toString(36).slice(2, 10); save(); }
    return st.seed;
  }

  /* ---------- gating ---------- */
  function status(content, idx) {
    var L = content.lessons[idx];
    var st = lessonState(L.id);
    if (st.passed) return { key: "passed", label: "Passed" };
    if (content.preview) return { key: "open", label: "Open" };
    if (L.opensAt > today()) return { key: "locked", label: "Opens " + fmtDate(L.opensAt) };
    if (idx > 0 && !lessonState(content.lessons[idx - 1].id).passed) return { key: "locked", label: "Locked" };
    return { key: "open", label: "Open" };
  }

  /* ---------- shared chrome ---------- */
  function chrome(content) {
    var c = content.course;
    document.querySelectorAll("[data-course-code]").forEach(function (n) { n.textContent = c.code; });
    document.querySelectorAll("[data-course-title]").forEach(function (n) { n.textContent = c.title; });
    document.querySelectorAll("[data-instructors]").forEach(function (n) { n.textContent = c.instructors.join(" · "); });
    if (content.preview) {
      var b = el("div", { class: "banner", role: "status" }, [
        el("div", { class: "wrap" }, [
          el("strong", { text: "Preview" }),
          el("span", { text: "Instructor review build. All lessons unlocked. Answers check against the draft key" + (content.built ? " built " + content.built.replace("T", " ") : "") + "." })
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
        el("span", { text: (h === 0 ? "First half" : "Second half") + " · Lessons " + Number(content.lessons[idxs[0]].id) + "–" + Number(content.lessons[idxs[idxs.length - 1]].id) }),
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

    var first = -1;
    content.lessons.forEach(function (L, i) { if (first < 0 && status(content, i).key === "open") first = i; });
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
          var msg = document.getElementById("import-msg");
          if (msg) msg.textContent = err ? "That file could not be read as SPR progress." : "Progress imported.";
          if (!err) setTimeout(function () { location.reload(); }, 600);
        });
      });
    }
  }

  /* ---------- inputs ---------- */
  function buildSelect(c, st, content, label) {
    var sel = el("select", { id: safeId(c.id), "aria-label": label || c.prompt });
    sel.appendChild(el("option", { value: "", text: "Choose…" }));
    var addOpt = function (parent, o) {
      var opt = el("option", { value: o, text: o });
      if (st.answers[c.id] === o) opt.selected = true;
      parent.appendChild(opt);
    };
    if (c.optionSet) {
      content.optionSets[c.optionSet].forEach(function (g) {
        var og = el("optgroup", { label: g.label });
        g.options.forEach(function (o) { addOpt(og, o); });
        sel.appendChild(og);
      });
    } else c.options.forEach(function (o) { addOpt(sel, o); });
    sel.addEventListener("change", function () { st.answers[c.id] = sel.value; save(); clearMark(c.id); });
    return sel;
  }

  function refNode(c) { return el("div", { class: "cell-ref", "data-ref": c.id, hidden: "" }, [el("strong", { text: "Where to look: " }), c.ref || "See the panel on the right."]); }

  function selectTable(cells, st, content) {
    var tbody = el("tbody");
    cells.forEach(function (c) {
      tbody.appendChild(el("tr", { "data-cell": c.id }, [
        el("td", null, [el("label", { for: safeId(c.id), text: c.prompt }), c.optional ? el("span", { class: "optional-tag", text: "Optional" }) : null, refNode(c)]),
        el("td", { class: "answer" }, [buildSelect(c, st, content)]),
        el("td", { class: "mark" }, [el("span", { class: "mark-text" })])
      ]));
    });
    return el("table", { class: "cell-table" }, [
      el("thead", null, [el("tr", null, [el("th", { text: "Item" }), el("th", { text: "Answer" }), el("th", { text: "" })])]),
      tbody
    ]);
  }

  function matrix(cells, st, content) {
    var groups = [], byGroup = {};
    cells.forEach(function (c) {
      var g = c.group || "";
      if (!byGroup[g]) { byGroup[g] = { rows: [], map: {}, cols: [] }; groups.push(g); }
      var G = byGroup[g];
      if (G.cols.indexOf(c.col) < 0) G.cols.push(c.col);
      if (!G.map[c.row]) { G.map[c.row] = {}; G.rows.push(c.row); }
      G.map[c.row][c.col] = c;
    });
    var wrap = el("div", { class: "matrix-wrap" });
    groups.forEach(function (g) {
      if (g) wrap.appendChild(el("h3", { class: "matrix-group", text: g }));
      var cols = byGroup[g].cols;
      var head = el("tr", null, [el("th", { text: "Muscle" })].concat(cols.map(function (k) { return el("th", { text: k }); })));
      var tbody = el("tbody");
      byGroup[g].rows.forEach(function (r) {
        var tr = el("tr", null, [el("th", { scope: "row", class: "row-head", text: r })]);
        cols.forEach(function (k) {
          var c = byGroup[g].map[r][k];
          if (!c) { tr.appendChild(el("td", { class: "na", text: "—" })); return; }
          tr.appendChild(el("td", { "data-cell": c.id }, [buildSelect(c, st, content, r + ": " + k), el("span", { class: "mark-text" }), refNode(c)]));
        });
        tbody.appendChild(tr);
      });
      wrap.appendChild(el("table", { class: "cell-table matrix" }, [el("thead", null, [head]), tbody]));
    });
    return wrap;
  }

  /* Checkbox answers are stored as the checked options, sorted by their normalized
     text and joined with " + " (matches build_content.py). */
  function multiValue(fieldset) {
    var vals = [];
    fieldset.querySelectorAll("input:checked").forEach(function (i) { vals.push(i.value); });
    vals.sort(function (a, b) { var x = window.SPRCheck.norm(a), y = window.SPRCheck.norm(b); return x < y ? -1 : x > y ? 1 : 0; });
    return vals.join(" + ");
  }

  function mcItem(c, n, st) {
    var opts = el("div", { class: "opts" });
    var multi = c.type === "multi";
    var chosen = multi ? (st.answers[c.id] || "").split(" + ") : [];
    var fs;
    seededShuffle(c.options, lessonSeed(st) + c.id).forEach(function (o, i) {
      var input = el("input", { type: multi ? "checkbox" : "radio", name: c.id, value: o, id: safeId(c.id) + "-" + i });
      if (multi ? chosen.indexOf(o) !== -1 : st.answers[c.id] === o) input.checked = true;
      input.addEventListener("change", function () {
        st.answers[c.id] = multi ? multiValue(fs) : o;
        save(); clearMark(c.id);
      });
      opts.appendChild(el("label", { for: safeId(c.id) + "-" + i }, [input, el("span", { text: o })]));
    });
    fs = el("fieldset", { class: "mc", "data-cell": c.id }, [
      el("legend", null, [el("span", { class: "qnum", text: n + "." }), c.prompt]),
      opts, el("span", { class: "mark-text" }), refNode(c)
    ]);
    return fs;
  }

  function clearMark(id) {
    var n = document.querySelector('[data-cell="' + id + '"]');
    if (!n) return;
    n.classList.remove("right", "wrong");
    var m = n.querySelector(".mark-text"); if (m) m.textContent = "";
  }

  function mark(id, ok, misses) {
    var n = document.querySelector('[data-cell="' + id + '"]');
    if (!n) return;
    n.classList.remove("right", "wrong");
    n.classList.add(ok ? "right" : "wrong");
    var m = n.querySelector(".mark-text");
    if (m) m.textContent = ok ? "Correct" : "Not correct";
    var ref = n.querySelector(".cell-ref");
    if (ref) { if (!ok && misses >= MISSES_FOR_REF) ref.removeAttribute("hidden"); else ref.setAttribute("hidden", ""); }
  }

  /* ---------- lesson ---------- */

  /* Reference figures: shown only once the lesson is passed. Image src is set on reveal so
     nothing is fetched before then. Every figure carries its own credit and license line. */
  function figuresPanel(L, content) {
    var src = content.figureSource;
    if (!L.figures || !L.figures.length || !src) return null;
    var box = el("section", { class: "figures", "aria-labelledby": "fig-h", hidden: "" }, [
      el("h2", { id: "fig-h", text: "Reference figures" }),
      el("p", { class: "fig-intro", text: "You passed this lesson. These figures show the structures you just named. They are OpenStax illustrations for orientation; where OpenStax and Neumann differ, the course follows Neumann." })
    ]);
    L.figures.forEach(function (f) {
      var img = el("img", { alt: f.alt, "data-src": ROOT + "/" + src.dir + f.file });
      var cap = el("figcaption", null, [
        el("strong", { text: "Figure " + f.number + ", " + f.title + ". " }),
        f.note ? el("span", { class: "fig-note", text: f.note + " " }) : null,
        el("span", { class: "fig-credit" }, [
          "From ", el("em", { text: src.book }), ", " + src.publisher + ", " + src.year + ", section ",
          el("a", { href: f.url, target: "_blank", rel: "noopener", text: f.section }), ". Licensed ",
          el("a", { href: src.licenseUrl, target: "_blank", rel: "noopener license", text: src.license }), ". " + src.changes
        ])
      ]);
      box.appendChild(el("figure", { class: "ref-figure" }, [img, cap]));
    });
    box.appendChild(el("p", { class: "fig-access" }, ["Access the book for free at ", el("a", { href: src.bookUrl, target: "_blank", rel: "noopener", text: src.bookUrl.replace("https://", "") }), "."]));
    box.reveal = function () {
      box.querySelectorAll("img[data-src]").forEach(function (i) { i.src = i.getAttribute("data-src"); i.removeAttribute("data-src"); });
      box.removeAttribute("hidden");
    };
    return box;
  }

  function renderLesson(content) {
    var id = document.body.getAttribute("data-lesson");
    var idx = -1;
    content.lessons.forEach(function (L, i) { if (L.id === id) idx = i; });
    var L = content.lessons[idx];
    var st = lessonState(id);
    var s = status(content, idx);
    document.title = "Lesson " + Number(L.id) + ": " + L.title + " · " + content.course.code;

    var main = document.querySelector("main");
    main.appendChild(el("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, [
      el("a", { href: ROOT + "/index.html", text: "Block 0" }), " / Lesson " + Number(L.id)
    ]));
    var statusSpan = el("span", { text: "Status: " + s.label });
    main.appendChild(el("header", { class: "lesson-head" }, [
      el("div", null, [el("p", { class: "eyebrow", text: "Lesson " + Number(L.id) + " of " + content.lessons.length }), el("h1", { text: L.title })]),
      el("div", { class: "lesson-meta" }, [
        el("span", { text: L.minutes[0] + " min fluent · " + L.minutes[1] + " min learning" }),
        el("span", { text: L.input }), statusSpan
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

    var cells = L.cells || [];
    var required = cells.filter(function (c) { return !c.optional; });
    var work = el("section", { class: "work", "aria-labelledby": "work-h" });
    work.appendChild(el("div", { class: "work-head" }, [
      el("h2", { id: "work-h", text: "Your answers" }),
      el("span", { class: "work-count", text: cells.length ? required.length + " items" : "" })
    ]));

    var next = content.lessons[idx + 1];
    if (!cells.length) {
      work.appendChild(el("div", { class: "locked-panel" }, [el("p", { class: "muted", text: "Items for this lesson are not drafted yet." })]));
    } else {
      if (L.layout === "mc") cells.forEach(function (c, i) { work.appendChild(mcItem(c, i + 1, st)); });
      else if (L.layout === "matrix") work.appendChild(matrix(cells, st, content));
      else work.appendChild(selectTable(L.shuffleRows ? seededShuffle(cells, lessonSeed(st)) : cells, st, content));

      var figs = figuresPanel(L, content);
      var result = el("span", { class: "result", role: "status", "aria-live": "polite",
        text: st.passed ? "Lesson passed. You can still change answers; it stays passed." : "Answers save automatically." });
      if (st.passed) result.className = "result ok";
      var btn = el("button", { class: "btn primary", type: "button", text: "Check answers" });
      var nextBtn = next ? el("a", { class: "btn", href: next.slug + ".html", text: "Next lesson →" }) : el("a", { class: "btn", href: ROOT + "/certificate.html", text: "Certificate →" });
      if (!st.passed) nextBtn.setAttribute("hidden", "");
      btn.addEventListener("click", function () {
        var blankN = required.filter(function (c) { return !st.answers[c.id]; }).length;
        if (blankN) { result.className = "result bad"; result.textContent = blankN + (blankN === 1 ? " item is" : " items are") + " still blank."; return; }
        btn.disabled = true;
        window.SPRCheck.checkCells(content.salt, cells, st.answers).then(function (res) {
          st.attempts += 1;
          var wrong = 0;
          cells.forEach(function (c) {
            if (res[c.id] === null) return;
            if (!res[c.id]) { wrong += 1; st.misses[c.id] = (st.misses[c.id] || 0) + 1; }
            mark(c.id, res[c.id], st.misses[c.id] || 0);
          });
          if (!wrong) {
            if (!st.passed) { st.passed = true; st.passedAt = new Date().toISOString(); }
            result.className = "result ok";
            result.textContent = "All correct. Lesson passed.";
            statusSpan.textContent = "Status: Passed";
            nextBtn.removeAttribute("hidden");
            if (figs) figs.reveal();
          } else {
            result.className = "result bad";
            result.textContent = wrong + " of " + cells.length + " not correct. Wrong items are marked; items missed " + MISSES_FOR_REF + " times show where to look.";
            var first = document.querySelector(".wrong select, .wrong input");
            if (first) first.focus();
          }
          save();
          btn.disabled = false;
        }).catch(function () {
          result.className = "result bad";
          result.textContent = "This browser could not check answers. Use a current version of Chrome, Edge, Firefox, or Safari.";
          btn.disabled = false;
        });
      });
      work.appendChild(el("div", { class: "check-bar" }, [result, el("div", { class: "btn-row" }, [btn, nextBtn])]));
    }
    left.appendChild(work);
    if (figs) { left.appendChild(figs); if (st.passed) figs.reveal(); }

    var where = el("aside", { class: "where", "aria-labelledby": "where-h" }, [el("h2", { id: "where-h", text: "Where to look" })]);
    var ul = el("ul");
    L.where.forEach(function (w) {
      ul.appendChild(el("li", null, [w.url ? el("a", { href: w.url, target: "_blank", rel: "noopener", text: w.label }) : document.createTextNode(w.label)]));
    });
    if (!L.where.length) ul.appendChild(el("li", { class: "muted", text: "To be added." }));
    where.appendChild(ul);
    where.appendChild(el("p", { class: "src-note", text: "A wrong answer is marked, never revealed. After " + MISSES_FOR_REF + " misses on the same item, its specific reference appears beside it." }));

    if (L.layout === "matrix") {
      where.classList.add("where-inline");
      left.insertBefore(where, work);
      main.appendChild(el("div", { class: "lesson-grid wide" }, [left]));
    } else {
      main.appendChild(el("div", { class: "lesson-grid" }, [left, where]));
    }

    var prev = content.lessons[idx - 1];
    main.appendChild(el("nav", { class: "pager", "aria-label": "Lesson navigation" }, [
      prev ? el("a", { href: prev.slug + ".html", text: "← " + prev.title }) : el("span"),
      next ? el("a", { href: next.slug + ".html", text: next.title + " →" }) : el("a", { href: ROOT + "/certificate.html", text: "Certificate →" })
    ]));
  }

  /* ---------- sources ---------- */
  function renderSources(content) {
    var host = document.getElementById("by-lesson");
    if (!host) return;
    content.lessons.forEach(function (L) {
      host.appendChild(el("h3", { text: "Lesson " + Number(L.id) + ": " + L.title }));
      var ul = el("ul", { class: "ref-list" });
      if (!L.where.length) ul.appendChild(el("li", { class: "muted", text: "To be added with this lesson." }));
      L.where.forEach(function (w) {
        ul.appendChild(el("li", null, [w.url ? el("a", { href: w.url, target: "_blank", rel: "noopener", text: w.label }) : document.createTextNode(w.label)]));
      });
      var pages = {};
      (L.cells || []).forEach(function (c) { if (c.ref && / p\. /.test(c.ref)) pages[c.ref] = true; });
      Object.keys(pages).sort().forEach(function (r) { ul.appendChild(el("li", { text: r })); });
      host.appendChild(ul);
    });
  }

  /* ---------- boot ---------- */
  load();
  fetch(ROOT + "/data/content.json", { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (content) {
      chrome(content);
      if (PAGE === "index") renderIndex(content);
      else if (PAGE === "lesson") renderLesson(content);
      else if (PAGE === "sources") renderSources(content);
      else wireProgressButtons();
    })
    .catch(function () {
      var main = document.querySelector("main");
      main.insertBefore(el("p", { class: "storage-warn", text: "Course content could not be loaded. If you opened this file directly from your computer, use the course link instead." }), main.firstChild);
    });
})();
