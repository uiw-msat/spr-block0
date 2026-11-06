"""End-to-end check of Lessons 1-5 against the instructor key, in headless Chrome.

    python3 tools/smoke_test.py path/to/key.xlsx [base_url]

For each lesson: answer one item wrong three times (it must be marked wrong and show its
reference on the third miss), then answer everything from the key's first accepted answer
(the lesson must pass). Needs a local server on base_url (default http://localhost:8765).
Run with the content.json built from the same key.
"""
import sys
from openpyxl import load_workbook
from playwright.sync_api import sync_playwright

SHEETS = {"L01_conventions": "01-conventions", "L02_landmarks": "02-landmarks", "L03_viscera": "03-viscera",
          "L04_attachments": "04-attachments", "L05_open_chain": "05-open-chain"}


def key_answers(path):
    wb = load_workbook(path, data_only=True)
    sites = [r[0] for r in wb["Options"].iter_rows(min_row=2, values_only=True) if r[0] and r[1] and not str(r[0]).startswith("Lesson")]
    out = {}
    for sheet, slug in SHEETS.items():
        ws = wb[sheet]
        hdr = {c.value: i for i, c in enumerate(ws[1])}
        rows = []
        for r in ws.iter_rows(min_row=2, values_only=True):
            if not r[0]:
                continue
            opts = sites if str(r[hdr["options"]]).startswith("See Options") else str(r[hdr["options"]]).split("|")
            acc = str(r[hdr["accept"]]).split("|")
            wrong = next(o for o in opts if o not in acc)
            rows.append((r[0], acc[0], wrong, r[hdr["type"]]))
        out[slug] = rows
    return out


def sid(cid):
    import re
    return "f-" + re.sub(r"[^a-z0-9]+", "-", cid, flags=re.I)


def answer(page, cid, typ, value):
    if typ == "mc":
        page.locator(f'[data-cell="{cid}"] input[value="{value}"]').check()
    else:
        page.select_option(f"#{sid(cid)}", value)


def main(path, base):
    data = key_answers(path)
    fails = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome")
        page = b.new_page(viewport={"width": 1280, "height": 900})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        for slug, rows in data.items():
            page.goto(f"{base}/lessons/{slug}.html")
            page.wait_for_selector("[data-cell]")
            # fill all correctly except the first item, which gets a wrong answer
            for i, (cid, right, wrong, typ) in enumerate(rows):
                answer(page, cid, typ, wrong if i == 0 else right)
            first = rows[0][0]
            for attempt in range(1, 4):
                page.click("text=Check answers")
                page.wait_for_function("document.querySelector('.result').textContent.includes('not correct')")
                cls = page.get_attribute(f'[data-cell="{first}"]', "class") or ""
                ref_hidden = page.locator(f'[data-ref="{first}"]').get_attribute("hidden")
                n_wrong = page.locator(".wrong").count()
                if "wrong" not in cls or n_wrong != 1:
                    fails.append(f"{slug}: attempt {attempt} marked {n_wrong} wrong (expected 1, on {first})")
                if attempt < 3 and ref_hidden is None:
                    fails.append(f"{slug}: reference shown before 3 misses")
                if attempt == 3 and ref_hidden is not None:
                    fails.append(f"{slug}: reference not shown after 3 misses")
            answer(page, first, rows[0][3], rows[0][1])
            page.click("text=Check answers")
            page.wait_for_function("document.querySelector('.result').textContent.includes('passed') || document.querySelector('.result').textContent.includes('not correct')")
            txt = page.text_content(".result")
            if "passed" not in txt:
                bad = [c for c in page.eval_on_selector_all(".wrong", "els => els.map(e => e.getAttribute('data-cell'))")]
                fails.append(f"{slug}: did not pass with key answers; wrong: {bad}")
            print(f"{slug}: {len(rows)} items checked; {txt.strip()}")
        page.goto(f"{base}/index.html")
        page.wait_for_selector(".status")
        passed = page.locator(".status.passed").count()
        print(f"landing shows {passed} lessons passed")
        page.screenshot(path="/home/claude/shots/after-pass.png", full_page=False)
        b.close()
    if errs:
        fails.append(f"page errors: {errs}")
    print("FAILURES:\n  " + "\n  ".join(fails) if fails else "ALL PASS")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8765")
