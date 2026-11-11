"""Read students' exported progress files (spr-progress-*.json, as uploaded to Canvas) and
report how many wrong attempts each student made.

    python3 tools/decode_progress.py path/to/folder_or_files... [--out reports/]

Prints one row per student and lesson, then the most-missed items across the class, and
writes both tables as CSV (students.csv, items.csv) to --out (default: current folder).

What the numbers mean:
  checks        times the student pressed a Check button (Lesson 4 counts each section check)
  wrong         wrong answers summed over all checks (an item wrong on three checks counts 3)
  items missed  items wrong on at least one check; "3+" = items that reached the reference reveal
  verified      saved answers that match the key, re-hashed here against data/content.json

The file is saved in the student's browser and can be edited, so treat counts as self-reported.
"verified" is recomputed from the saved answers and does not depend on the file's "passed" flag.
No answer key is needed or read.
"""
import argparse
import csv
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def norm(s):
    return re.sub(r"\s+", " ", str(s).strip().lower())


def label(c):
    return f"{c['row']}: {c['col']}" if c.get("row") else c["prompt"]


def correct(salt, c, ans):
    if not ans:
        return False
    return hashlib.sha256(f"{salt}|{c['id']}|{norm(ans)}".encode("utf-8")).hexdigest() in c["accept"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="progress .json files, or folders of them")
    ap.add_argument("--content", default=str(ROOT / "data/content.json"))
    ap.add_argument("--out", default=".")
    ap.add_argument("--top", type=int, default=15, help="how many most-missed items to print")
    a = ap.parse_args()

    content = json.loads(pathlib.Path(a.content).read_text())
    salt = content["salt"]
    lessons = [L for L in content["lessons"] if L.get("cells")]

    files = []
    for p in map(pathlib.Path, a.paths):
        files += sorted(p.rglob("*.json")) if p.is_dir() else [p]

    student_rows, item_stats, skipped = [], {}, []
    for f in files:
        try:
            prog = json.loads(f.read_text(encoding="utf-8-sig"))
            if not isinstance(prog.get("lessons"), dict):
                raise ValueError("no lessons")
        except Exception as e:  # not a progress file
            skipped.append(f"{f.name}: {e}")
            continue
        name = (prog.get("studentName") or "").strip() or f.stem
        for L in lessons:
            st = prog["lessons"].get(L["id"]) or {}
            misses = {k: int(v) for k, v in (st.get("misses") or {}).items() if v}
            answers = st.get("answers") or {}
            required = [c for c in L["cells"] if not c.get("optional")]
            ok = sum(correct(salt, c, answers.get(c["id"])) for c in required)
            known = {c["id"] for c in L["cells"]}
            student_rows.append({
                "student": name, "file": f.name, "lesson": int(L["id"]), "title": L["title"],
                "passed": "yes" if st.get("passed") else "no", "passed_at": (st.get("passedAt") or "")[:16].replace("T", " "),
                "checks": st.get("attempts", 0), "wrong": sum(v for k, v in misses.items() if k in known),
                "items_missed": sum(1 for k in misses if k in known), "items_missed_3plus": sum(1 for k, v in misses.items() if k in known and v >= 3),
                "items": len(required), "verified": ok,
                "flag": "passed flag without all answers correct" if st.get("passed") and ok < len(required) else "",
            })
            for c in L["cells"]:
                s = item_stats.setdefault((L["id"], c["id"]), {"lesson": int(L["id"]), "group": c.get("group", ""), "item": label(c),
                                                             "students_missed": 0, "total_misses": 0, "max_misses": 0, "students": 0})
                s["students"] += 1 if st else 0
                m = misses.get(c["id"], 0)
                if m:
                    s["students_missed"] += 1
                    s["total_misses"] += m
                    s["max_misses"] = max(s["max_misses"], m)

    if not student_rows:
        sys.exit("No progress files found." + ("\nSkipped:\n  " + "\n  ".join(skipped) if skipped else ""))

    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    items = sorted(item_stats.values(), key=lambda s: (-s["students_missed"], -s["total_misses"], s["lesson"]))
    for fname, rows in (("students.csv", student_rows), ("items.csv", items)):
        with open(out / fname, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    n = len({r["file"] for r in student_rows})
    print(f"{n} progress file(s)\n")
    print(f"{'Student':24} {'L':>2} {'Passed':6} {'Checks':>6} {'Wrong':>5} {'Items missed':>12} {'3+':>3} {'Verified':>9}  Flag")
    for r in student_rows:
        if not r["checks"] and r["passed"] == "no":
            continue  # lesson not started
        print(f"{r['student'][:24]:24} {r['lesson']:>2} {r['passed']:6} {r['checks']:>6} {r['wrong']:>5} "
              f"{str(r['items_missed']) + ' of ' + str(r['items']):>12} {r['items_missed_3plus']:>3} {str(r['verified']) + '/' + str(r['items']):>9}  {r['flag']}")
    print(f"\nMost-missed items (of {n} students)")
    print(f"{'L':>2} {'Students':>8} {'Misses':>6}  Item")
    for s in items[: a.top]:
        if s["students_missed"]:
            print(f"{s['lesson']:>2} {s['students_missed']:>8} {s['total_misses']:>6}  {s['item']}")
    if skipped:
        print("\nSkipped (not progress files):\n  " + "\n  ".join(skipped))
    print(f"\nWrote {out / 'students.csv'} and {out / 'items.csv'}")


if __name__ == "__main__":
    main()
