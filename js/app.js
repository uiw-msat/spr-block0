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
    set("[data-due]", fmtDate(c.certificateDue) + (c.certificateDueTime ? ", " + c.certificateDueTime : ""));
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
    /* A saved answer that is no longer in this list (the list was narrowed) counts as blank. */
    if (st.answers[c.id] && sel.value !== st.answers[c.id]) { delete st.answers[c.id]; save(); }
    sel.addEventListener("change", function () {
      st.answers[c.id] = sel.value;
      if (st.sectionsOK && st.sectionsOK[sectionOf(c)]) {
        delete st.sectionsOK[sectionOf(c)];
        var sec = sel.closest(".matrix-section"), r = sec && sec.querySelector(".result");
        if (r) { r.className = "result"; r.textContent = "Answers save automatically."; }
      }
      save(); clearMark(c.id);
    });
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

  /* A section is what one Check button covers. It holds one table per group; most sections
     are a single group, in which case the section and the group are the same thing. */
  function sectionOf(c) { return c.section || c.group || ""; }

  /* Paged lessons (Lesson 8) show one section at a time, with a tab per section.
     The open tab is remembered for the visit only. */
  function pager(mx, lessonId) {
    mx.classList.add("paged");
    var secs = Array.prototype.slice.call(mx.querySelectorAll(".matrix-section"));
    var nav = el("div", { class: "page-tabs", role: "tablist", "aria-label": "Sections" });
    var tabs = secs.map(function (sec, i) {
      var h = sec.querySelector(".matrix-group");
      var b = el("button", { class: "page-tab", type: "button", role: "tab", text: (h ? h.textContent : "Section " + (i + 1)).split(" \u00b7 ")[0] });
      b.addEventListener("click", function () { show(i); });
      nav.appendChild(b);
      return b;
    });
    function show(i) {
      secs.forEach(function (sec, k) { sec.classList.toggle("current", k === i); });
      tabs.forEach(function (b, k) { b.setAttribute("aria-selected", k === i ? "true" : "false"); });
      try { sessionStorage.setItem("spr-page-" + lessonId, String(i)); } catch (e) {}
    }
    var start = 0;
    try { start = parseInt(sessionStorage.getItem("spr-page-" + lessonId), 10) || 0; } catch (e) {}
    show(Math.min(start, secs.length - 1));
    return nav;
  }

  function matrix(cells, st, content, sectionBar, rowHead) {
    var sections = [], bySection = {};
    cells.forEach(function (c) {
      var sk = sectionOf(c), g = c.group || "";
      if (!bySection[sk]) { bySection[sk] = { groups: [], byGroup: {} }; sections.push(sk); }
      var S = bySection[sk];
      if (!S.byGroup[g]) { S.byGroup[g] = { rows: [], map: {}, cols: [] }; S.groups.push(g); }
      var G = S.byGroup[g];
      if (G.cols.indexOf(c.col) < 0) G.cols.push(c.col);
      if (!G.map[c.row]) { G.map[c.row] = {}; G.rows.push(c.row); }
      G.map[c.row][c.col] = c;
    });
    var wrap = el("div", { class: "matrix-wrap" });
    sections.forEach(function (sk) {
      var S = bySection[sk];
      var sec = el("section", { class: "matrix-section" });
      wrap.appendChild(sec);
      if (sk) sec.appendChild(el("h3", { class: "matrix-group", text: sk }));
      S.groups.forEach(function (g) {
        var G = S.byGroup[g];
        if (g && g !== sk && S.groups.length > 1) sec.appendChild(el("h4", { class: "matrix-subgroup", text: g }));
        var head = el("tr", null, [el("th", { text: rowHead || "Muscle" })].concat(G.cols.map(function (k) { return el("th", { text: k }); })));
        var tbody = el("tbody");
        G.rows.forEach(function (r) {
          var tr = el("tr", null, [el("th", { scope: "row", class: "row-head", text: r })]);
          G.cols.forEach(function (k) {
            var c = G.map[r][k];
            if (!c) { tr.appendChild(el("td", { class: "na", text: "—" })); return; }
            tr.appendChild(el("td", { "data-cell": c.id }, [buildSelect(c, st, content, r + ": " + k), el("span", { class: "mark-text" }), refNode(c)]));
          });
          tbody.appendChild(tr);
        });
        sec.appendChild(el("table", { class: "cell-table matrix" }, [el("thead", null, [head]), tbody]));
      });
      if (sectionBar) sec.appendChild(sectionBar(sk, cells.filter(function (c) { return sectionOf(c) === sk; })));
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
    if (L.layout === "synthesis") {
      /* Free text, read by the instructors. Gated on word count only; saved to progress.synthesis. */
      var store = load().synthesis || (load().synthesis = {});
      var minWords = L.minWords || 60;
      var words = function (t) { var m = String(t || "").trim().match(/\S+/g); return m ? m.length : 0; };
      var sResult = el("span", { class: "result lesson-result" + (st.passed ? " ok" : ""), role: "status", "aria-live": "polite" });
      var sNext = el("a", { class: "btn", href: ROOT + "/certificate.html", text: "Certificate \u2192" });
      var boxes = [];
      var refresh = function () {
        var done = boxes.every(function (b) { return words(b.value) >= minWords; });
        if (done && !st.passed) { st.passed = true; st.passedAt = new Date().toISOString(); }
        save();
        sResult.textContent = st.passed ? "Lesson passed. Your answers are saved and can still be edited." : "Each answer needs at least " + minWords + " words. Answers save as you type.";
        sResult.className = "result lesson-result" + (st.passed ? " ok" : "");
        if (st.passed) sNext.removeAttribute("hidden"); else sNext.setAttribute("hidden", "");
      };
      (L.prompts || []).forEach(function (pr, i) {
        var id = "synth-" + pr.id;
        var count = el("span", { class: "word-count" });
        var ta = el("textarea", { class: "synth", id: id, rows: "7" });
        ta.value = store[pr.id] || "";
        var upd = function () { var n = words(ta.value); count.textContent = n + " of " + minWords + " words" + (n >= minWords ? " \u2713" : ""); };
        ta.addEventListener("input", function () { store[pr.id] = ta.value; upd(); refresh(); });
        upd(); boxes.push(ta);
        work.appendChild(el("div", { class: "synth-item" }, [el("label", { for: id, text: (i + 1) + ". " + pr.text }), ta, count]));
      });
      work.querySelector(".work-count").textContent = boxes.length + " written answers";
      refresh();
      work.appendChild(el("div", { class: "check-bar static" }, [sResult, el("div", { class: "btn-row" }, [sNext])]));
    } else if (!cells.length) {
      work.appendChild(el("div", { class: "locked-panel" }, [el("p", { class: "muted", text: "Items for this lesson are not drafted yet." })]));
    } else {
      var sectioned = L.layout === "matrix" && !!L.sectionCheck;
      var figs = figuresPanel(L, content);
      var result = el("span", { class: "result lesson-result", role: "status", "aria-live": "polite",
        text: st.passed ? "Lesson passed. You can still change answers; it stays passed."
          : sectioned ? "Check each section as you finish it. The lesson passes when every section is correct." : "Answers save automatically." });
      if (st.passed) result.className = "result lesson-result ok";
      var nextBtn = next ? el("a", { class: "btn", href: next.slug + ".html", text: "Next lesson →" }) : el("a", { class: "btn", href: ROOT + "/certificate.html", text: "Certificate →" });
      if (!st.passed) nextBtn.setAttribute("hidden", "");

      /* Check the cells in scope (the whole lesson, or one section). Every cell is hashed so the
         lesson can pass as soon as all of it is correct, but only cells in scope are marked and
         only their misses are counted. */
      var runCheck = function (scope, out, btn, group) {
        var blankN = scope.filter(function (c) { return !c.optional && !st.answers[c.id]; }).length;
        if (blankN) { out.className = out.className.replace(/ (ok|bad)$/, "") + " bad"; out.textContent = blankN + (blankN === 1 ? " item is" : " items are") + " still blank."; return; }
        var base = out.className.replace(/ (ok|bad)$/, "");
        btn.disabled = true;
        window.SPRCheck.checkCells(content.salt, cells, st.answers).then(function (res) {
          st.attempts += 1;
          var wrong = 0;
          scope.forEach(function (c) {
            if (res[c.id] === null) return;
            if (!res[c.id]) { wrong += 1; st.misses[c.id] = (st.misses[c.id] || 0) + 1; }
            mark(c.id, res[c.id], st.misses[c.id] || 0);
          });
          var lessonOK = cells.every(function (c) { return res[c.id] === true || (c.optional && res[c.id] === null); });
          if (group !== undefined) {
            st.sectionsOK = st.sectionsOK || {};
            if (wrong) delete st.sectionsOK[group]; else st.sectionsOK[group] = true;
          }
          /* A sectioned lesson passes only when every section has itself been checked and is correct. */
          if (sectioned) lessonOK = lessonOK && cells.every(function (c) { return st.sectionsOK[sectionOf(c)]; });
          if (wrong) {
            out.className = base + " bad";
            out.textContent = wrong + " of " + scope.length + " not correct. Wrong items are marked; items missed " + MISSES_FOR_REF + " times show where to look.";
            var first = btn.closest(".matrix-section, .work").querySelector(".wrong select, .wrong input");
            if (first) first.focus();
          } else if (!lessonOK) {
            out.className = base + " ok";
            out.textContent = "Section correct.";
          }
          if (lessonOK) {
            if (!st.passed) { st.passed = true; st.passedAt = new Date().toISOString(); }
            if (out !== result) { out.className = base + " ok"; out.textContent = "Section correct."; }
            result.className = "result lesson-result ok";
            result.textContent = sectioned ? "All sections correct. Lesson passed." : "All correct. Lesson passed.";
            statusSpan.textContent = "Status: Passed";
            nextBtn.removeAttribute("hidden");
            if (figs) figs.reveal();
          }
          save();
          btn.disabled = false;
        }).catch(function () {
          out.className = base + " bad";
          out.textContent = "This browser could not check answers. Use a current version of Chrome, Edge, Firefox, or Safari.";
          btn.disabled = false;
        });
      };

      var sectionBar = !sectioned ? null : function (group, scope) {
        var ok = st.sectionsOK && st.sectionsOK[group];
        var out = el("span", { class: "result" + (ok ? " ok" : ""), role: "status", "aria-live": "polite", text: ok ? "Section correct." : scope.length + " items in this section." });
        var b = el("button", { class: "btn primary check", type: "button", text: "Check this section" });
        b.addEventListener("click", function () { runCheck(scope, out, b, group); });
        return el("div", { class: "section-bar" }, [out, b]);
      };

      if (L.layout === "mc") cells.forEach(function (c, i) { work.appendChild(mcItem(c, i + 1, st)); });
      else if (L.layout === "matrix") {
        var mx = matrix(cells, st, content, sectionBar, L.rowHead);
        if (L.paged) work.appendChild(pager(mx, L.id));
        work.appendChild(mx);
      }
      else work.appendChild(selectTable(L.shuffleRows ? seededShuffle(cells, lessonSeed(st)) : cells, st, content));

      var btn = sectioned ? null : el("button", { class: "btn primary check", type: "button", text: "Check answers" });
      if (btn) btn.addEventListener("click", function () { runCheck(cells, result, btn); });
      work.appendChild(el("div", { class: "check-bar" + (sectioned ? " static" : "") }, [result, el("div", { class: "btn-row" }, [btn, nextBtn])]));
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

  /* ---------- certificate ----------
     Opens only when every saved answer re-checks against content.json (the passed flags are not
     trusted: a student can change answers after passing). The code ties the name, the completion
     time, and every answer together; tools/verify.py recomputes it from the uploaded progress file. */
  function wordCount(t) { var m = String(t || "").trim().match(/\S+/g); return m ? m.length : 0; }

  function completionReport(content) {
    var p = load();
    return Promise.all(content.lessons.map(function (L) {
      var st = p.lessons[L.id] || {};
      if (L.layout === "synthesis") {
        var min = L.minWords || 60, syn = p.synthesis || {};
        var short = (L.prompts || []).filter(function (pr) { return wordCount(syn[pr.id]) < min; }).length;
        return Promise.resolve({ L: L, ok: short === 0 && (L.prompts || []).length > 0, short: short, passedAt: st.passedAt });
      }
      var cells = (L.cells || []).filter(function (c) { return !c.optional; });
      return window.SPRCheck.checkCells(content.salt, cells, st.answers || {}).then(function (res) {
        var bad = cells.filter(function (c) { return res[c.id] !== true; }).length;
        return { L: L, ok: cells.length > 0 && bad === 0, bad: bad, passedAt: st.passedAt };
      });
    }));
  }

  function longDate(iso) { return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); }
  function fileSafe(s) { return (s || "student").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase(); }

  function certificatePDF(content, cert) {
    var c = content.course;
    var doc = new window.jspdf.jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
    var W = 792, H = 612, cx = W / 2;
    var ox = [122, 31, 43], ink = [29, 31, 34], grey = [95, 100, 108];
    doc.setProperties({ title: c.code + " Block 0 certificate: " + cert.name, subject: c.title + ", " + c.block,
      author: c.instructors.join("; "), creator: "SPR Block 0 site", keywords: "spr-code:" + cert.code + " term:" + content.term });

    doc.setDrawColor.apply(doc, ox); doc.setLineWidth(2.5); doc.rect(28, 28, W - 56, H - 56);
    doc.setLineWidth(0.6); doc.rect(36, 36, W - 72, H - 72);

    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor.apply(doc, grey);
    doc.text(c.program.toUpperCase(), cx, 82, { align: "center", charSpace: 0.6 });

    doc.setFont("times", "bold"); doc.setFontSize(26); doc.setTextColor.apply(doc, ox);
    doc.text(c.code + "  " + c.title.replace("&", "and"), cx, 128, { align: "center" });
    doc.setFont("times", "italic"); doc.setFontSize(15); doc.setTextColor.apply(doc, ink);
    doc.text(c.block + " · " + c.term, cx, 154, { align: "center" });

    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor.apply(doc, grey);
    doc.text("RECORD OF COMPLETION", cx, 208, { align: "center", charSpace: 1.2 });

    doc.setFont("times", "bold"); doc.setTextColor.apply(doc, ink);
    var size = 36; doc.setFontSize(size);
    while (doc.getTextWidth(cert.name) > W - 200 && size > 18) { size -= 2; doc.setFontSize(size); }
    doc.text(cert.name, cx, 262, { align: "center" });
    doc.setDrawColor.apply(doc, grey); doc.setLineWidth(0.5); doc.line(cx - 220, 276, cx + 220, 276);

    doc.setFont("times", "normal"); doc.setFontSize(14);
    doc.text("completed all " + content.lessons.length + " lessons of the asynchronous Block 0 primer", cx, 306, { align: "center" });
    doc.text("on " + longDate(cert.completedAt) + ".", cx, 326, { align: "center" });

    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor.apply(doc, grey);
    doc.text("INSTRUCTORS", cx, 380, { align: "center", charSpace: 1 });
    doc.setFont("times", "normal"); doc.setFontSize(13); doc.setTextColor.apply(doc, ink);
    c.instructors.forEach(function (n, i) { doc.text(n, cx, 400 + i * 18, { align: "center" }); });

    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor.apply(doc, grey);
    doc.text("VERIFICATION CODE", cx, 470, { align: "center", charSpace: 1 });
    doc.setFont("courier", "bold"); doc.setFontSize(20); doc.setTextColor.apply(doc, ox);
    doc.text(window.SPRCheck.shortCode(cert.code), cx, 494, { align: "center", charSpace: 1 });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor.apply(doc, grey);
    doc.text("Valid only with the progress file submitted with it. Instructors verify the code against that file.", cx, 512, { align: "center" });

    doc.setFontSize(8);
    doc.text("A completion record for a university course primer. Not a Postural Restoration Institute course or credential.", cx, 552, { align: "center" });
    doc.text("Issued " + longDate(cert.issuedAt) + " · term " + content.term + " · code " + cert.code, cx, 564, { align: "center" });

    if (content.preview) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(60); doc.setTextColor(200, 200, 200);
      doc.text("PREVIEW: NOT VALID", cx, 340, { align: "center", angle: 18 });
    }
    return doc;
  }

  function renderCertificate(content) {
    var host = document.getElementById("cert-app");
    var due = (content.course.certificateDueTime ? content.course.certificateDueTime + " on " : "") + fmtDate(content.course.certificateDue);
    completionReport(content).then(function (rows) {
      host.textContent = "";
      var missing = rows.filter(function (r) { return !r.ok; });
      if (missing.length) {
        var ul = el("ul", { class: "cert-missing" });
        missing.forEach(function (r) {
          var why = r.L.layout === "synthesis"
            ? (r.short ? r.short + (r.short === 1 ? " answer is" : " answers are") + " under the word minimum" : "not started")
            : (r.bad ? r.bad + (r.bad === 1 ? " item needs" : " items need") + " another look" : "not started");
          ul.appendChild(el("li", null, [el("a", { href: "lessons/" + r.L.slug + ".html", text: "Lesson " + Number(r.L.id) + ": " + r.L.title }), " — " + why]));
        });
        host.appendChild(el("div", { class: "locked-panel cert-locked" }, [
          el("h2", { text: "Not available yet" }),
          el("p", { text: "The certificate opens when every lesson's saved answers are correct. " + (missing.length === 1 ? "One lesson is" : missing.length + " lessons are") + " not complete:" }),
          ul,
          el("p", { class: "muted", text: "If you passed a lesson and later changed an answer, open the lesson and check it again." })
        ]));
        return;
      }

      var p = load();
      var completedAt = rows.map(function (r) { return r.passedAt || ""; }).sort().pop();
      if (!completedAt) completedAt = new Date().toISOString();   // passed flags missing (edited file): use now
      var input = el("input", { id: "cert-name", type: "text", autocomplete: "name", spellcheck: "false", value: (p.certificate && p.certificate.name) || p.studentName || "" });
      var make = el("button", { class: "btn primary", type: "button", text: "Create certificate" });
      var msg = el("span", { class: "result", role: "status" });
      var out = el("div", { class: "cert-out", hidden: "" });

      host.appendChild(el("div", { class: "cert-form" }, [
        el("p", { class: "result ok", text: "All " + rows.length + " lessons complete." }),
        el("label", { for: "cert-name", text: "Your name exactly as it appears in Canvas" }),
        el("div", { class: "btn-row" }, [input, make, msg])
      ]));
      host.appendChild(out);

      var show = function (cert) {
        out.textContent = "";
        var pdfBtn = el("button", { class: "btn primary", type: "button", text: "1. Download certificate (PDF)" });
        var jsonBtn = el("button", { class: "btn primary", type: "button", text: "2. Download progress file (JSON)" });
        pdfBtn.addEventListener("click", function () { certificatePDF(content, cert).save("SPR-certificate-" + fileSafe(cert.name) + ".pdf"); });
        jsonBtn.addEventListener("click", exportProgress);
        out.appendChild(el("dl", { class: "cert-summary" }, [
          el("div", null, [el("dt", { text: "Name" }), el("dd", { text: cert.name })]),
          el("div", null, [el("dt", { text: "Completed" }), el("dd", { text: longDate(cert.completedAt) })]),
          el("div", null, [el("dt", { text: "Verification code" }), el("dd", { class: "cert-code", text: window.SPRCheck.shortCode(cert.code) })])
        ]));
        out.appendChild(el("div", { class: "btn-row" }, [pdfBtn, jsonBtn]));
        out.appendChild(el("p", { class: "cert-upload", text: "3. Upload both files to the Block 0 certificate assignment in Canvas by " + due + ". The code on the certificate is checked against the progress file, so upload the progress file downloaded from this page after creating the certificate. If you change any answer or your name, create the certificate again and upload both new files." }));
        if (content.course.canvasUrl) out.appendChild(el("p", null, [el("a", { class: "btn", href: content.course.canvasUrl, target: "_blank", rel: "noopener", text: "Open the Canvas assignment" })]));
        out.removeAttribute("hidden");
      };

      var create = function () {
        var name = window.SPRCheck.certName(input.value);
        if (name.length < 3 || !/\S+ \S+/.test(name)) { msg.className = "result bad"; msg.textContent = "Enter your first and last name as Canvas shows them."; input.focus(); return; }
        make.disabled = true;
        window.SPRCheck.certificateCode(content.salt, name, completedAt, content, p).then(function (r) {
          var prev = p.certificate;
          var cert = { version: 1, name: name, completedAt: completedAt, code: r.code, answersHash: r.answersHash,
            issuedAt: prev && prev.code === r.code ? prev.issuedAt : new Date().toISOString(), term: content.term };
          p.studentName = name; p.certificate = cert; save(); input.value = name;
          msg.className = "result ok"; msg.textContent = "Certificate created.";
          make.disabled = false; make.textContent = "Create again";
          show(cert);
        }).catch(function () {
          msg.className = "result bad"; msg.textContent = "This browser could not create the code. Use a current version of Chrome, Edge, Firefox, or Safari.";
          make.disabled = false;
        });
      };
      make.addEventListener("click", create);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") create(); });

      /* A certificate already saved and still matching the answers is shown again as is. */
      if (p.certificate && p.certificate.name) {
        window.SPRCheck.certificateCode(content.salt, p.certificate.name, completedAt, content, p).then(function (r) {
          if (r.code === p.certificate.code) { make.textContent = "Create again"; show(p.certificate); }
          else { msg.className = "result bad"; msg.textContent = "Your answers changed since your last certificate. Create it again and upload both new files."; }
        });
      }
      if (!window.jspdf) { msg.className = "result bad"; msg.textContent = "The PDF tool did not load. Reload the page."; make.disabled = true; }
    }).catch(function () {
      host.textContent = "";
      host.appendChild(el("p", { class: "storage-warn", text: "This browser could not check your answers. Use a current version of Chrome, Edge, Firefox, or Safari." }));
    });
    wireProgressButtons();
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
      else if (PAGE === "certificate") renderCertificate(content);
      else wireProgressButtons();
    })
    .catch(function () {
      var main = document.querySelector("main");
      main.insertBefore(el("p", { class: "storage-warn", text: "Course content could not be loaded. If you opened this file directly from your computer, use the course link instead." }), main.firstChild);
    });
})();
