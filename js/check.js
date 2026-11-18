/* SPR Block 0 — answer normalization and hashing. Must match tools/build_content.py:
   SHA-256(salt + "|" + cellId + "|" + normalized answer), hex. */
(function () {
  "use strict";

  function norm(s) { return String(s).trim().toLowerCase().replace(/\s+/g, " "); }

  function hex(buf) {
    var b = new Uint8Array(buf), out = "";
    for (var i = 0; i < b.length; i++) out += ("0" + b[i].toString(16)).slice(-2);
    return out;
  }

  function hash(salt, cellId, answer) {
    var data = new TextEncoder().encode(salt + "|" + cellId + "|" + norm(answer));
    return crypto.subtle.digest("SHA-256", data).then(hex);
  }

  /* Returns a Promise of { id: true|false|null } — null for blank cells and for optional (ungraded) cells. */
  function checkCells(salt, cells, answers) {
    return Promise.all(cells.map(function (c) {
      var a = answers[c.id];
      if (!a || c.optional) return Promise.resolve([c.id, null]);   // optional cells are saved, never graded
      return hash(salt, c.id, a).then(function (d) { return [c.id, c.accept.indexOf(d) !== -1]; });
    })).then(function (pairs) {
      var r = {};
      pairs.forEach(function (p) { r[p[0]] = p[1]; });
      return r;
    });
  }

  /* ---------- certificate code. Must match tools/verify.py. ----------
     answersHash = SHA-256 of one line per graded cell, lessons in site order, cells sorted by id:
                   "<cellId>=<normalized answer>", then one line per synthesis prompt, sorted by id:
                   "synthesis:<promptId>=<text exactly as saved>"; lines joined with "\n".
     code        = SHA-256(salt + "|" + name + "|" + completedAt + "|" + answersHash), hex.
     name        = as typed, trimmed, runs of spaces collapsed. completedAt = latest lesson passedAt. */
  function sha256(str) { return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then(hex); }
  function certName(s) { return String(s || "").replace(/[ \t\r\n ]+/g, " ").replace(/^ | $/g, ""); }
  function byId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

  function canonicalAnswers(content, progress) {
    var lines = [];
    content.lessons.forEach(function (L) {
      var st = (progress.lessons || {})[L.id] || {}, ans = st.answers || {};
      (L.cells || []).filter(function (c) { return !c.optional; }).slice().sort(byId).forEach(function (c) {
        lines.push(c.id + "=" + norm(ans[c.id] || ""));
      });
      if (L.layout === "synthesis") (L.prompts || []).slice().sort(byId).forEach(function (pr) {
        lines.push("synthesis:" + pr.id + "=" + String((progress.synthesis || {})[pr.id] || ""));
      });
    });
    return lines.join("\n");
  }

  function certificateCode(salt, name, completedAt, content, progress) {
    return sha256(canonicalAnswers(content, progress)).then(function (answersHash) {
      return sha256(salt + "|" + certName(name) + "|" + completedAt + "|" + answersHash).then(function (code) {
        return { code: code, answersHash: answersHash };
      });
    });
  }
  function shortCode(code) { return code.slice(0, 12).toUpperCase().replace(/(.{4})(?=.)/g, "$1-"); }

  window.SPRCheck = { norm: norm, hash: hash, checkCells: checkCells, sha256: sha256, certName: certName,
    canonicalAnswers: canonicalAnswers, certificateCode: certificateCode, shortCode: shortCode };
})();
