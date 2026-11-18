"""Verify Block 0 certificates against the progress files students uploaded to Canvas.

    python3 tools/verify.py path/to/canvas_downloads... [--out reports/]

Point it at the folder of files downloaded from the Canvas assignment (Download Submissions),
or at individual files. For every progress file (.json) it:

  1. re-checks every graded answer against data/content.json (no answer key needed), and the
     Lesson 10 word minimum;
  2. recomputes the certificate code from the name, completion time, and answers in the file,
     and compares it with the code saved in the file;
  3. finds the certificate PDF with the same code (pypdf reads the code the site writes into
     the PDF) and reports whether the student uploaded a matching pair;
  4. flags files that look copied: a lesson shuffle seed that appears in more than one file
     (each browser draws its own), or a Lesson 10 answer identical to another student's.

Writes certificates.csv (one row per student) and synthesis.md (every student's Lesson 10
answers, for reading before Unit 1) to --out. Exit status is 0 even when students fail checks;
read the VERDICT column.

The code formula must match certificateCode() in js/check.js:
    answersHash = sha256("\n".join(lines)), lines = "<cellId>=<norm answer>" for each graded cell
                  (lessons in site order, cells sorted by id), then "synthesis:<promptId>=<text>"
    code        = sha256(salt + "|" + name + "|" + completedAt + "|" + answersHash)
"""
import argparse
import csv
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CANVAS_PREFIX = re.compile(r"^(?P<who>[a-z0-9]+)_(?:late_)?(?P<uid>\d+)_\d+_", re.I)   # Canvas Download Submissions names


def norm(s):
    return re.sub(r"\s+", " ", str(s).strip().lower())


def cert_name(s):
    return re.sub(r"[ \t\r\n ]+", " ", str(s or "")).strip(" ")


def sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def short(code):
    c = code[:12].upper()
    return f"{c[0:4]}-{c[4:8]}-{c[8:12]}"


def words(t):
    return len(str(t or "").split())


def canonical(content, prog):
    lines = []
    for L in content["lessons"]:
        ans = ((prog.get("lessons") or {}).get(L["id"]) or {}).get("answers") or {}
        for c in sorted((c for c in L.get("cells") or [] if not c.get("optional")), key=lambda c: c["id"]):
            lines.append(f"{c['id']}={norm(ans.get(c['id']) or '')}")
        if L.get("layout") == "synthesis":
            for pr in sorted(L.get("prompts") or [], key=lambda p: p["id"]):
                lines.append(f"synthesis:{pr['id']}={str((prog.get('synthesis') or {}).get(pr['id']) or '')}")
    return "\n".join(lines)


def code_for(content, prog, name, completed_at):
    answers_hash = sha(canonical(content, prog))
    return sha(f"{content['salt']}|{cert_name(name)}|{completed_at}|{answers_hash}"), answers_hash


def lesson_report(content, prog):
    """Per lesson: (lesson id, ok, detail)."""
    salt, out = content["salt"], []
    for L in content["lessons"]:
        st = (prog.get("lessons") or {}).get(L["id"]) or {}
        if L.get("layout") == "synthesis":
            mn = L.get("minWords", 60)
            short_n = sum(words((prog.get("synthesis") or {}).get(p["id"])) < mn for p in L.get("prompts") or [])
            out.append((L["id"], short_n == 0, f"{short_n} under {mn} words" if short_n else ""))
            continue
        cells = [c for c in L.get("cells") or [] if not c.get("optional")]
        ans = st.get("answers") or {}
        bad = sum(1 for c in cells if not ans.get(c["id"]) or
                  hashlib.sha256(f"{salt}|{c['id']}|{norm(ans[c['id']])}".encode()).hexdigest() not in c["accept"])
        out.append((L["id"], bad == 0 and bool(cells), f"{bad} of {len(cells)} wrong or blank" if bad else ""))
    return out


def pdf_code(path):
    """The full code the site writes into the PDF (keywords metadata, and the footer text)."""
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.exit("verify.py needs pypdf to read certificates: pip install pypdf")
    try:
        r = PdfReader(str(path))
        meta = (r.metadata or {}).get("/Keywords") or ""
        m = re.search(r"spr-code:([0-9a-f]{64})", str(meta))
        if m:
            return m.group(1), "metadata"
        text = " ".join(p.extract_text() or "" for p in r.pages)
        m = re.search(r"code ([0-9a-f]{64})", text)
        if m:
            return m.group(1), "text"
        m = re.search(r"\b([0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4})\b", text)
        return (m.group(1), "short") if m else (None, "no code found")
    except Exception as e:
        return None, f"unreadable ({e.__class__.__name__})"


def who(path):
    m = CANVAS_PREFIX.match(path.name)
    return m.group("uid") if m else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="Canvas submission files, or folders of them")
    ap.add_argument("--content", default=str(ROOT / "data/content.json"))
    ap.add_argument("--out", default=".")
    a = ap.parse_args()

    content = json.loads(pathlib.Path(a.content).read_text())
    files = []
    for p in map(pathlib.Path, a.paths):
        files += sorted(f for f in p.rglob("*") if f.is_file()) if p.is_dir() else [p]
    seen, uniq = set(), []
    for f in files:   # the same file downloaded twice counts once
        h = hashlib.sha256(f.read_bytes()).hexdigest()
        if h not in seen:
            seen.add(h)
            uniq.append(f)
    files = uniq
    jsons = [f for f in files if f.suffix.lower() == ".json"]
    pdfs = {f: pdf_code(f) for f in files if f.suffix.lower() == ".pdf"}

    rows, synth, seeds, texts, skipped, used_pdfs = [], [], {}, {}, [], set()
    for f in jsons:
        try:
            prog = json.loads(f.read_text(encoding="utf-8-sig"))
            if not isinstance(prog.get("lessons"), dict):
                raise ValueError("no lessons")
        except Exception as e:
            skipped.append(f"{f.name}: {e}")
            continue
        cert = prog.get("certificate") or {}
        name = cert_name(cert.get("name") or prog.get("studentName") or "") or f.stem
        lessons = lesson_report(content, prog)
        n_ok = sum(ok for _, ok, _ in lessons)
        problems = [f"L{int(i)}: {d or 'incomplete'}" for i, ok, d in lessons if not ok]
        passed_at = sorted(((prog["lessons"].get(L["id"]) or {}).get("passedAt") or "") for L in content["lessons"])[-1]

        if cert.get("code"):
            code, _ = code_for(content, prog, cert.get("name"), cert.get("completedAt"))
            code_ok = code == cert["code"]
            if not code_ok:
                problems.append("file changed after the certificate was made (code does not recompute)")
            if cert.get("completedAt") != passed_at:
                problems.append("completion time does not match the lesson pass times")
            if cert.get("term") and cert["term"] != content["term"]:
                problems.append(f"certificate from term {cert['term']}")
        else:
            code, code_ok = None, False
            problems.append("no certificate in this progress file (exported before the certificate was created)")

        # the PDF: same Canvas student first, else any PDF carrying this code
        match, pdf_note = None, "no PDF found"
        if code:
            mine = [p for p in pdfs if who(p) and who(p) == who(f)] or list(pdfs)
            for p in mine:
                pc, how = pdfs[p]
                if pc and (pc == cert["code"] or (how == "short" and pc == short(cert["code"]))):
                    match, pdf_note = p, "matches" + (" (short code only)" if how == "short" else "")
                    break
            if not match:
                own = [p for p in pdfs if who(p) and who(p) == who(f)]
                pdf_note = f"PDF code does not match ({own[0].name})" if own else "no PDF with this code"
                problems.append(pdf_note)
            else:
                used_pdfs.add(match)

        for L in content["lessons"]:
            s = (prog["lessons"].get(L["id"]) or {}).get("seed")
            if s:
                seeds.setdefault(s, set()).add(name)
        for pid, t in (prog.get("synthesis") or {}).items():
            if words(t) >= 10:
                texts.setdefault(norm(t), set()).add(name)
        synth.append((name, prog.get("synthesis") or {}))

        rows.append({"student": name, "file": f.name, "lessons_ok": f"{n_ok}/{len(lessons)}",
                     "code": short(cert["code"]) if cert.get("code") else "", "code_recomputes": "yes" if code_ok else "no",
                     "pdf": match.name if match else "", "pdf_check": pdf_note,
                     "completed_at": (cert.get("completedAt") or passed_at or "")[:16].replace("T", " "),
                     "problems": problems})

    if not rows:
        sys.exit("No progress files found." + ("\nSkipped:\n  " + "\n  ".join(skipped) if skipped else ""))

    for s, names in seeds.items():
        if len(names) > 1:
            for r in rows:
                if r["student"] in names:
                    r["problems"].append("shares a browser seed with " + ", ".join(sorted(names - {r["student"]})))
    for t, names in texts.items():
        if len(names) > 1:
            for r in rows:
                if r["student"] in names:
                    r["problems"].append("a Lesson 10 answer is identical to " + ", ".join(sorted(names - {r["student"]})))
    for r in rows:
        r["problems"] = sorted(set(r["problems"]), key=r["problems"].index)
        r["verdict"] = "VERIFIED" if not r["problems"] else "CHECK"
        r["problems"] = "; ".join(r["problems"])

    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    cols = ["verdict", "student", "lessons_ok", "code", "code_recomputes", "pdf_check", "completed_at", "problems", "file", "pdf"]
    with open(out / "certificates.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)

    syn_lesson = next((L for L in content["lessons"] if L.get("layout") == "synthesis"), None)
    prompts = syn_lesson.get("prompts") if syn_lesson else []
    md = [f"# Lesson 10 synthesis answers ({len(synth)} students)\n"]
    for i, pr in enumerate(prompts, 1):
        md.append(f"\n## {i}. {pr['text']}\n")
        for name, s in sorted(synth, key=lambda x: x[0].lower()):
            md.append(f"\n**{name}** ({words(s.get(pr['id']))} words)\n\n{(s.get(pr['id']) or '_No answer._').strip()}\n")
    (out / "synthesis.md").write_text("".join(md), encoding="utf-8")

    print(f"{len(rows)} progress file(s), {len(pdfs)} PDF(s)\n")
    print(f"{'Verdict':9} {'Student':26} {'Lessons':7} {'Code':15} {'PDF':10}  Problems")
    for r in sorted(rows, key=lambda r: (r["verdict"] != "CHECK", r["student"].lower())):
        pdfc = "match" if r["pdf_check"].startswith("matches") else "no match"
        print(f"{r['verdict']:9} {r['student'][:26]:26} {r['lessons_ok']:7} {r['code'] or '-':15} {pdfc:10}  {r['problems']}")
    stray = [p.name for p in pdfs if p not in used_pdfs]
    if stray:
        print("\nPDFs not matched to any progress file:\n  " + "\n  ".join(stray))
    if skipped:
        print("\nSkipped (not progress files):\n  " + "\n  ".join(skipped))
    print(f"\nWrote {out / 'certificates.csv'} and {out / 'synthesis.md'}")


if __name__ == "__main__":
    main()
