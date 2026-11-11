"""Build data/content.json from data/lessons.json (hand-edited lesson text) and the
instructor answer key (.xlsx, never committed).

    python3 tools/build_content.py path/to/SPR_answer_key.xlsx

Answers are stored only as SHA-256(salt | cell_id | normalized answer). Including the
cell id means two cells with the same answer ("Left") do not share a hash.
"""
import hashlib
import json
import pathlib
import re
import sys
from datetime import datetime, timezone

from openpyxl import load_workbook

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHEETS = {"L01_conventions": "01", "L02_landmarks": "02", "L03_viscera": "03",
          "L04_attachments": "04", "L05_open_chain": "05",
          "L06_proximal_on_distal": "06", "L07_diaphragm": "07"}
SITE_OPTS = "See Options sheet: Attachment sites"
CHAINS = ["femur-on-pelvis (FA), from anatomical position", "thorax-on-pelvis, pelvis fixed, unilateral contraction",
          "scapula-on-thorax (ST)", "humerus-on-glenoid (HG)"]
# Trunk rows (Nov 11): one cell for both sides contracting, one for one side contracting.
CHAINS.append("thorax-on-pelvis, pelvis fixed")
CHAIN_LABEL = {CHAINS[0]: "Hip muscles · femur-on-pelvis (FA)",
               CHAINS[1]: "Trunk muscles · thorax-on-pelvis, one side contracting",
               CHAINS[2]: "Scapular muscles · scapula-on-thorax (ST)",
               CHAINS[3]: "Latissimus dorsi · humerus-on-glenoid (HG)"}
CHAIN_LABEL[CHAINS[4]] = "Trunk muscles · thorax-on-pelvis"
# Lesson 6: the proximal segment moves on a fixed distal one.
CHAINS.append("pelvis-on-femur (AF), femur fixed")
CHAIN_LABEL[CHAINS[5]] = "Hip muscles · pelvis-on-femur (AF)"
# Lesson 4: one table per body section. The section comes from the key's options column
# ("See Options sheet: Attachment sites, Hip"); its dropdown lists only the sites the Options
# sheet assigns to that section. Neumann's attachment terms differ by region.
SECTION_LABEL = {"Anterior hip": "Anterior hip muscles · proximal and distal attachments",
                 "Hamstrings": "Hamstrings · proximal and distal attachments",
                 "Adductors": "Adductors · proximal and distal attachments",
                 "Gluteal": "Gluteal muscles and deep rotators · proximal and distal attachments",
                 "Shoulder": "Shoulder muscles · proximal and distal attachments",
                 "Trunk": "Diaphragm and trunk muscles · inferior and superior attachments",
                 "Abdominal wall": "Abdominal wall · lateral and medial attachments"}


def norm(s):
    return re.sub(r"\s+", " ", str(s).strip().lower())


def h(salt, cid, ans):
    return hashlib.sha256(f"{salt}|{cid}|{norm(ans)}".encode("utf-8")).hexdigest()


def header_index(ws):
    return {str(c.value).strip(): i for i, c in enumerate(ws[1]) if c.value}


def main(key_path):
    meta = json.loads((ROOT / "data/lessons.json").read_text())
    salt = meta["salt"]
    wb = load_workbook(key_path, data_only=True)

    # attachment sites with groups (Lesson 4 option list)
    # option sets: "sites" = every site; "sites-<section>" = the sites listed for that section
    option_sets = {"sites": []}
    op = wb["Options"]
    for row in op.iter_rows(min_row=2, values_only=True):
        if not row[0] or not row[1] or str(row[0]).startswith("Lesson"):
            continue
        secs = [x.strip() for x in str(row[2] or "").split("|") if x.strip()] if len(row) > 2 else []
        for name in ["sites"] + ["sites-" + x for x in secs]:
            groups = option_sets.setdefault(name, [])
            if not groups or groups[-1]["label"] != row[1]:
                groups.append({"label": str(row[1]), "options": []})
            groups[-1]["options"].append(str(row[0]))

    # page lookups
    pages = {}
    pg = wb["Pages"]
    for row in pg.iter_rows(min_row=2, values_only=True):
        if row[0] and row[1]:
            pages[str(row[0])] = {"book": row[1], "ch": row[2], "what": row[3],
                                  "page": "" if row[4] is None else str(row[4]).strip()}

    problems, cells_by_lesson = [], {}
    for sheet, lid in SHEETS.items():
        if sheet not in wb.sheetnames:      # a key that stops at an earlier lesson still builds
            continue
        ws = wb[sheet]
        ix = header_index(ws)
        out = []
        for r in ws.iter_rows(min_row=2, values_only=True):
            cid = r[ix["cell_id"]]
            if not cid:
                continue
            cid = str(cid).strip()
            prompt = str(r[ix["prompt"]]).strip()
            prompt = prompt.replace("Which bone bears this landmark? ", "")
            typ = str(r[ix["type"]]).strip()
            opt_raw = str(r[ix["options"]]).strip()
            accept = [a.strip() for a in str(r[ix["accept"]]).split("|") if a.strip()]
            optional = str(r[ix["flag"]] or "").strip().upper() == "OPTIONAL"
            section, option_set = None, None
            if opt_raw.startswith(SITE_OPTS):
                section = opt_raw[len(SITE_OPTS):].lstrip(", ").strip() or None
                option_set = "sites-" + section if section else "sites"
                if option_set not in option_sets:
                    problems.append(f"{sheet} {cid}: no sites listed for section '{section}' on the Options sheet")
                    continue
                if section and section not in SECTION_LABEL:
                    problems.append(f"{sheet} {cid}: unknown section '{section}'")
                options = [o for g in option_sets[option_set] for o in g["options"]]
            else:
                options = [o.strip() for o in opt_raw.split("|")]
            bad = [a for a in accept if norm(a) not in {norm(o) for o in options}]
            if bad or not accept:
                problems.append(f"{sheet} {cid}: accept {bad or '(empty)'} not in options")

            # per-cell reference shown after three misses
            src = str(r[ix["source"]] or "").strip()
            look = str(r[ix["lookup"]] or "").strip() if "lookup" in ix else ""
            ref = src
            if look and look in pages:
                p = pages[look]
                ref = f"{p['book']}, {p['ch']}: {p['what']}"
                if p["page"]:
                    ref += f", {'pp.' if any(ch in p['page'] for ch in '-,') else 'p.'} {p['page']}"

            if typ == "multi":
                # one correct SET: hash the sorted, normalized members joined with " + "
                hashes = [h(salt, cid, " + ".join(sorted(norm(a) for a in accept)))]
            else:
                hashes = sorted({h(salt, cid, a) for a in accept})
            cell = {"id": cid, "type": typ, "prompt": prompt, "accept": hashes, "ref": ref}
            if option_set:
                cell["optionSet"] = option_set
            else:
                cell["options"] = options
            if optional:
                cell["optional"] = True
            if lid in ("04", "05", "06"):
                left, col = prompt.rsplit(": ", 1)
                group = SECTION_LABEL.get(section) if lid == "04" else None
                for ch in CHAINS:
                    if left.endswith(", " + ch):
                        left, group = left[: -len(ch) - 2], CHAIN_LABEL[ch]
                cell.update({"row": left, "col": col.replace(" plane", "").capitalize()})
                if group:
                    cell["group"] = group
            out.append(cell)
        ids = [c["id"] for c in out]
        if len(ids) != len(set(ids)):
            problems.append(f"{sheet}: duplicate cell ids")
        cells_by_lesson[lid] = out

    if problems:
        sys.exit("Key problems, nothing written:\n  " + "\n  ".join(problems))

    # lessons.json may group a matrix lesson's rows into sections (one Check button each):
    # "sections": [{"label": ..., "rows": [row names]}]. Every row must be in exactly one.
    for L in meta["lessons"]:
        secs = L.get("sections")
        if not secs:
            continue
        where = {}
        for sec in secs:
            for r in sec["rows"]:
                if r in where:
                    problems.append(f"lessons.json {L['id']}: row '{r}' is in two sections")
                where[r] = sec["label"]
        rows = {c["row"] for c in cells_by_lesson.get(L["id"], [])}
        for r in sorted(rows - set(where)):
            problems.append(f"lessons.json {L['id']}: row '{r}' is not in any section")
        for r in sorted(set(where) - rows):
            problems.append(f"lessons.json {L['id']}: section row '{r}' is not in the key")
        order = {sec["label"]: i for i, sec in enumerate(secs)}
        for c in cells_by_lesson.get(L["id"], []):
            if c["row"] in where:
                c["section"] = where[c["row"]]
        cells_by_lesson[L["id"]] = sorted(cells_by_lesson.get(L["id"], []), key=lambda c: order.get(c.get("section"), 0))
    if problems:
        sys.exit("Section problems, nothing written:\n  " + "\n  ".join(problems))

    for L in meta["lessons"]:
        L["cells"] = cells_by_lesson.get(L["id"], [])
    used = {c.get("optionSet") for v in cells_by_lesson.values() for c in v}
    meta["optionSets"] = {k: v for k, v in option_sets.items() if k in used}
    meta["built"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    meta["keySource"] = pathlib.Path(key_path).name
    (ROOT / "data/content.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n")
    n = sum(len(v) for v in cells_by_lesson.values())
    missing = sorted({c["ref"] for v in cells_by_lesson.values() for c in v if ", p. " not in c["ref"] and ", pp. " not in c["ref"] and c["ref"].startswith("Neumann 2017, ")})
    print(f"content.json: {n} cells across {len(cells_by_lesson)} lessons; {len(missing)} Neumann refs still without a page")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
