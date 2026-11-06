"""Generate the thin lesson wrapper pages from data/content.json. Run from repo root."""
import json, pathlib

TPL = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lesson {n}: {title} · ATHP 6190</title>
  <meta name="robots" content="noindex">
  <link rel="stylesheet" href="../css/site.css">
</head>
<body data-root=".." data-page="lesson" data-lesson="{id}">
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="wrap">
      <a class="brand" href="../index.html"><span class="code" data-course-code>ATHP 6190</span><span class="name" data-course-title>Spine &amp; Postural Restoration</span></a>
      <nav class="site-nav" aria-label="Site">
        <a href="../index.html">Lessons</a>
        <a href="../certificate.html">Certificate</a>
        <a href="../sources.html">Sources</a>
        <a href="../about.html">About</a>
      </nav>
    </div>
  </header>
  <main id="main" class="wrap"></main>
  <footer class="site-footer">
    <div class="wrap"><p><span data-course-code>ATHP 6190</span> · University of the Incarnate Word, MSAT · <span data-instructors></span></p></div>
  </footer>
  <script src="../js/app.js"></script>
</body>
</html>
"""

content = json.loads(pathlib.Path("data/content.json").read_text())
out = pathlib.Path("lessons")
out.mkdir(exist_ok=True)
for L in content["lessons"]:
    (out / f"{L['slug']}.html").write_text(TPL.format(n=int(L["id"]), title=L["title"], id=L["id"]))
print("wrote", len(content["lessons"]), "pages")
