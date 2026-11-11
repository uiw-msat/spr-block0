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
          "L04_attachments": "04-attachments", "L05_open_chain": "05-distal-on-proximal",
          "L06_proximal_on_distal": "06-proximal-on-distal",
          "L07_diaphragm": "07-diaphragm", "L08_gait": "08-gait-chart"}


def key_answers(path):
    wb = load_workbook(path, data_only=True)
    site_rows = [r for r in wb["Options"].iter_rows(min_row=2, values_only=True) if r[0] and r[1] and not str(r[0]).startswith("Lesson")]

    def sites_for(opt):
        # "See Options sheet: Attachment sites, Hip" -> the sites the Options sheet lists for Hip
        sec = opt.split("Attachment sites", 1)[1].lstrip(", ").strip()
        return [r[0] for r in site_rows if not sec or sec in [x.strip() for x in str(r[2] or "").split("|")]]
    out = {}
    for sheet, slug in SHEETS.items():
        if sheet not in wb.sheetnames:
            continue
        ws = wb[sheet]
        hdr = {c.value: i for i, c in enumerate(ws[1])}
        rows = []
        for r in ws.iter_rows(min_row=2, values_only=True):
            if not r[0]:
                continue
            opts = sites_for(str(r[hdr["options"]])) if str(r[hdr["options"]]).startswith("See Options") else str(r[hdr["options"]]).split("|")
            acc = str(r[hdr["accept"]]).split("|")
            typ = r[hdr["type"]]
            if typ == "multi":
                rows.append((r[0], acc, [opts[0]], typ, opts))   # right = the whole set; wrong = one box only
            else:
                wrong = next(o for o in opts if o not in acc)
                rows.append((r[0], acc[0], wrong, typ, opts))
        out[slug] = rows
    return out


def sid(cid):
    import re
    return "f-" + re.sub(r"[^a-z0-9]+", "-", cid, flags=re.I)


def answer(page, cid, typ, value):
    if typ == "multi":
        for box in page.locator(f'[data-cell="{cid}"] input[type=checkbox]').all():
            box.uncheck()
        for v in value:
            page.locator(f'[data-cell="{cid}"] input[value="{v}"]').check()
    elif typ == "mc":
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
        # lessons with a future release date are tested with the browser clock set past it
        page.clock.set_fixed_time("2026-12-31T12:00:00")
        page.on("pageerror", lambda e: errs.append(str(e)))
        for slug, rows in data.items():
            page.goto(f"{base}/lessons/{slug}.html")
            page.wait_for_selector("[data-cell]")
            page.evaluate("document.body.classList.add('show-all-pages')")   # paged lessons: every section on screen
            # fill all correctly except the first item, which gets a wrong answer
            sectioned = page.locator(".section-bar").count() > 0
            for i, (cid, right, wrong, typ, opts) in enumerate(rows):
                if typ == "select":
                    shown = page.eval_on_selector(f"#{sid(cid)}", "s => Array.from(s.options).map(o => o.value).filter(v => v)")
                    if sorted(shown) != sorted(opts):
                        fails.append(f"{slug}: {cid} lists {len(shown)} options, key has {len(opts)}")
                answer(page, cid, typ, wrong if i == 0 else right)
            first = rows[0][0]
            # sectioned lessons: the button and result of the section holding the first item
            sec = f'.matrix-section:has([data-cell="{first}"])' if sectioned else ".work"
            check, res = f"{sec} button.check", f"{sec} .result"
            if sectioned and page.locator("button.check").count() != page.locator(".matrix-section").count():
                fails.append(f"{slug}: not every section has a check button")
            n_figs = page.locator(".figures figure").count()
            if n_figs and page.locator(".figures").get_attribute("hidden") is None:
                fails.append(f"{slug}: reference figures visible before the lesson is passed")
            for attempt in range(1, 4):
                page.click(check)
                page.wait_for_function("s => document.querySelector(s).textContent.includes('not correct')", arg=res)
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
            buttons = page.locator("button.check")
            for k in range(buttons.count()):
                if sectioned and k == buttons.count() - 1 and "passed" in page.text_content(".lesson-result"):
                    fails.append(f"{slug}: lesson passed before the last section was checked")
                buttons.nth(k).click()
                page.wait_for_function("k => { const b = document.querySelectorAll('button.check')[k]; const r = b.closest('.matrix-section, .work').querySelector('.result'); return !b.disabled && /correct|passed/.test(r.textContent); }", arg=k)
            txt = page.text_content(".lesson-result")
            if sectioned:
                # a saved answer that is not in a section's list comes back blank after a reload
                page.evaluate("([id, lesson]) => { const p = JSON.parse(localStorage.getItem('spr-block0-progress')); p.lessons[lesson].answers[id] = 'Not a listed option'; localStorage.setItem('spr-block0-progress', JSON.stringify(p)); }", [first, slug[:2]])
                page.reload(); page.wait_for_selector("[data-cell]"); page.evaluate("document.body.classList.add('show-all-pages')")
                if page.input_value(f"#{sid(first)}") != "" or "Section correct" not in page.text_content(f"{check} >> xpath=.."):
                    fails.append(f"{slug}: stale answer not cleared, or section state lost on reload")
                answer(page, first, rows[0][3], rows[0][1])
            if "passed" not in txt:
                bad = [c for c in page.eval_on_selector_all(".wrong", "els => els.map(e => e.getAttribute('data-cell'))")]
                fails.append(f"{slug}: did not pass with key answers; wrong: {bad}")
            if n_figs and "passed" in txt:
                if page.locator(".figures").get_attribute("hidden") is not None:
                    fails.append(f"{slug}: reference figures still hidden after the pass")
                page.locator(".figures").scroll_into_view_if_needed()
                page.wait_for_function("Array.from(document.querySelectorAll('.figures img')).every(i => i.complete)")
                broken = page.eval_on_selector_all(".figures img", "els => els.filter(i => !i.naturalWidth).map(i => i.getAttribute('src'))")
                if broken:
                    fails.append(f"{slug}: figures failed to load: {broken}")
            print(f"{slug}: {len(rows)} items checked; {txt.strip()}" + (f" {n_figs} figures shown." if n_figs else ""))
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
