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

  window.SPRCheck = { norm: norm, hash: hash, checkCells: checkCells };
})();
