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
          "L07_diaphragm": "07-diaphragm", "L08_gait": "08-gait-chart", "L09_pattern": "09-pattern-map"}


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
            if str(r[hdr["flag"]] or "").strip().upper() == "OPTIONAL":
                rows.append((r[0], opts[-1], opts[0], typ, opts))   # ungraded: any answer must do
            elif typ == "multi":
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


def atlas_checks(browser, page, base):
    """Field Atlas: locked for an empty browser; after every lesson passes, every section renders,
    the gait chart has a column per phase, and the printed PDF has the gait pages in landscape."""
    import tempfile, pathlib
    fails = []
    fresh = browser.new_page()
    fresh.goto(f"{base}/atlas.html")
    fresh.wait_for_selector("#atlas .locked-panel, #atlas .a-cover", state="attached")
    if fresh.locator(".a-cover").count():
        fails.append("atlas: an empty browser can open the atlas")
    fresh.close()
    page.goto(f"{base}/atlas.html")
    page.wait_for_selector("#atlas .locked-panel, #atlas .a-cover", state="attached")
    if not page.locator(".a-cover").count():
        return fails + ["atlas: not shown after every lesson passed"]
    n = page.locator(".atlas-page").count()
    if n != 9:
        fails.append(f"atlas: {n} sections (expected cover + 8)")
    phases = page.locator(".gait-tab thead th.ph").count()
    if phases != 8:
        fails.append(f"atlas: gait chart has {phases} phase columns")
    blanks = page.eval_on_selector_all(".atlas-page td", "els => els.filter(e => e.textContent === '\u2014' && !e.closest('.gait-tab, .a-block')).length")
    if blanks:
        fails.append(f"atlas: {blanks} blank answer cells outside the matrix tables")
    if page.get_attribute("#atlas-print", "hidden") is not None:
        fails.append("atlas: print button hidden")
    pdf = pathlib.Path(tempfile.mkdtemp(prefix="spr-atlas-")) / "atlas.pdf"
    page.pdf(path=str(pdf), prefer_css_page_size=True, print_background=True)
    from pypdf import PdfReader
    sizes = [(round(float(pg.mediabox.width)), round(float(pg.mediabox.height))) for pg in PdfReader(str(pdf)).pages]
    if not any(w > h for w, h in sizes) or not any(h > w for w, h in sizes):
        fails.append(f"atlas: expected portrait pages and landscape gait pages, got {set(sizes)}")
    print(f"atlas: {n} sections, {len(sizes)} printed pages ({sum(w > h for w, h in sizes)} landscape); {pdf}")
    return fails


def certificate_checks(browser, page, base):
    """Certificate page: locked for an empty browser; after every lesson passes, creates a PDF and
    a progress file that tools/verify.py accepts; tampered files fail verification."""
    import copy, json, pathlib, subprocess, tempfile
    fails, tmp = [], pathlib.Path(tempfile.mkdtemp(prefix="spr-cert-"))
    verify = pathlib.Path(__file__).resolve().parent / "verify.py"

    fresh = browser.new_page()
    fresh.goto(f"{base}/certificate.html")
    fresh.wait_for_selector(".cert-locked, .cert-form")
    if fresh.locator(".cert-form").count() or fresh.locator(".cert-missing li").count() != 10:
        fails.append("certificate: an empty browser is not locked out with all ten lessons listed")
    fresh.close()

    page.goto(f"{base}/certificate.html")
    page.wait_for_selector(".cert-form, .cert-locked")
    if not page.locator(".cert-form").count():
        return fails + ["certificate: form not shown after every lesson passed: " + page.text_content("#cert-app")]
    page.fill("#cert-name", "Pat")
    page.click("text=Create certificate")
    if "first and last name" not in page.text_content(".cert-form .result.bad"):
        fails.append("certificate: a one-word name was accepted")
    page.fill("#cert-name", "  Pat   Smoke-Test ")
    page.click("text=Create certificate")
    page.wait_for_selector(".cert-out:not([hidden])")
    shown = page.text_content(".cert-code").strip()
    with page.expect_download() as d:
        page.click("text=Download certificate (PDF)")
    d.value.save_as(tmp / "smoketestpat_101_1_SPR-certificate-pat-smoke-test.pdf")
    with page.expect_download() as d:
        page.click("text=Download progress file (JSON)")
    d.value.save_as(tmp / "smoketestpat_101_2_spr-progress-pat-smoke-test.json")
    prog = json.loads((tmp / "smoketestpat_101_2_spr-progress-pat-smoke-test.json").read_text())
    if prog.get("certificate", {}).get("name") != "Pat Smoke-Test":
        fails.append(f"certificate: name not normalized/saved: {prog.get('certificate', {}).get('name')!r}")
    page.screenshot(path="/home/claude/shots/certificate.png", full_page=True)
    canvas = page.locator("text=Open the Canvas assignment")
    if canvas.count() != 1 or "canvas.uiw.edu/courses/" not in (canvas.get_attribute("href") or ""):
        fails.append("certificate: Canvas assignment button missing or not a Canvas course link")
    if page.locator('a[href="atlas.html"]').count() < 2:
        fails.append("certificate: no link to the Field Atlas after creating the certificate")

    # a reload shows the same certificate, same code
    page.reload(); page.wait_for_selector(".cert-out:not([hidden])")
    if page.text_content(".cert-code").strip() != shown:
        fails.append("certificate: code changed on reload")

    import csv, shutil

    def run_verify(folder):
        r = subprocess.run([sys.executable, str(verify), str(folder), "--out", str(folder / "reports")], capture_output=True, text=True)
        if r.returncode:
            raise RuntimeError("verify.py crashed:\n" + r.stderr)
        return {row["file"]: row for row in csv.DictReader(open(folder / "reports/certificates.csv"))}

    # the genuine pair, alone
    gdir = tmp / "genuine"; gdir.mkdir()
    for f in tmp.glob("smoketestpat_*"):
        shutil.copy(f, gdir)
    res = run_verify(gdir)
    good = res.get("smoketestpat_101_2_spr-progress-pat-smoke-test.json", {})
    if good.get("verdict") != "VERIFIED" or not good.get("pdf_check", "").startswith("matches"):
        fails.append(f"certificate: genuine pair not verified: {good}")
    if good.get("code") != shown:
        fails.append(f"certificate: page shows {shown}, verify.py computes {good.get('code')}")
    if "Pat Smoke-Test" not in (gdir / "reports/synthesis.md").read_text():
        fails.append("certificate: synthesis.md missing the student's answers")

    # tampered copies next to it: one answer changed; name changed (a classmate's file renamed)
    t1 = copy.deepcopy(prog); L = next(k for k in t1["lessons"] if t1["lessons"][k].get("answers"))
    cid = next(iter(t1["lessons"][L]["answers"])); t1["lessons"][L]["answers"][cid] = "Edited"
    t2 = copy.deepcopy(prog); t2["certificate"]["name"] = "Someone Else"
    mdir = tmp / "mixed"; shutil.copytree(gdir, mdir, ignore=shutil.ignore_patterns("reports"))
    (mdir / "tamperanswer_102_1_x.json").write_text(json.dumps(t1))
    (mdir / "tampername_103_1_x.json").write_text(json.dumps(t2))
    res = run_verify(mdir)
    for nm, why in (("tamperanswer_102_1_x.json", "wrong or blank"), ("tampername_103_1_x.json", "changed after")):
        row = res.get(nm, {})
        if row.get("verdict") != "CHECK" or why not in row.get("problems", ""):
            fails.append(f"certificate: tampered file {nm} not caught: {row.get('problems')}")
    if "shares a browser seed" not in res.get("tampername_103_1_x.json", {}).get("problems", ""):
        fails.append("certificate: copied file not flagged by shared seed")

    # changing an answer after the certificate locks the page until the lesson is fixed
    page.evaluate("([l, id]) => { const p = JSON.parse(localStorage.getItem('spr-block0-progress')); p.lessons[l].answers[id] = 'Edited'; localStorage.setItem('spr-block0-progress', JSON.stringify(p)); }", [L, cid])
    page.reload(); page.wait_for_selector(".cert-locked, .cert-form")
    if page.locator(".cert-missing li").count() != 1:
        fails.append("certificate: a changed answer after passing did not lock the certificate")
    print(f"certificate: created {shown}; verify.py: genuine pair {good.get('verdict')}, tampered files caught; files in {tmp}")
    return fails


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
        # Lesson 10: free text, gated on word count only
        page.goto(f"{base}/lessons/10-synthesis.html")
        if page.locator("textarea.synth").count():
            boxes = page.locator("textarea.synth")
            boxes.nth(0).fill("word " * 59)
            if "passed" in page.text_content(".lesson-result"):
                fails.append("10-synthesis: passed with one answer under the minimum")
            for k in range(boxes.count()):
                boxes.nth(k).fill("word " * 60)
            page.wait_for_function("document.querySelector('.lesson-result').textContent.includes('passed')")
            saved = page.evaluate("Object.keys(JSON.parse(localStorage.getItem('spr-block0-progress')).synthesis).length")
            if saved != boxes.count():
                fails.append("10-synthesis: answers not saved to progress")
            print(f"10-synthesis: {boxes.count()} written answers; " + page.text_content(".lesson-result").strip())
        else:
            fails.append("10-synthesis: no text boxes (previous lessons not passed?)")
        page.goto(f"{base}/index.html")
        page.wait_for_selector(".status")
        passed = page.locator(".status.passed").count()
        print(f"landing shows {passed} lessons passed")
        page.screenshot(path="/home/claude/shots/after-pass.png", full_page=False)
        fails += atlas_checks(b, page, base)
        fails += certificate_checks(b, page, base)
        b.close()
    if errs:
        fails.append(f"page errors: {errs}")
    print("FAILURES:\n  " + "\n  ".join(fails) if fails else "ALL PASS")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8765")
