/**
 * Yandex Music — import tracks from a VK-style list ("Artist - Title" per line).
 *
 * Run on https://music.yandex.ru (search page or any page with the main search box).
 *
 * Playlist target (your existing playlist name as it appears in the “Add to playlist” submenu):
 *   window.__YM_PLAYLIST_NAME = "New playlist";   // default if unset
 *   // or several aliases: window.__YM_PLAYLIST_NAME = ["New playlist", "Новый плейлист"];
 *
 * Track list — paste the REAL multiline text (browser JS has no @file references):
 *   window.__YM_TRACKS = `BIZZBA - Time Warp
 * Баста - Лампочка
 * ...`;
 * Wrong: `window.__YM_TRACKS = \`@vk-playlist.txt\`` — that is only editor chat notation, not file contents.
 *
 * Or leave __YM_TRACKS unset and paste lines in the overlay.
 *
 * Each line: search → wait up to 3s for best track result → Like → ⋮ → Add to playlist →
 * click the menu row whose title matches __YM_PLAYLIST_NAME (same playlist every time).
 *
 * Tracks with no matching result block within 3s go to ym-not-found.txt (downloaded at the end).
 */
(function () {
    const SEARCH_RESULT_TIMEOUT_MS = 3000;
    const MENU_TIMEOUT_MS = 3500;
    const STEP_DELAY_MS = 350;
    const BETWEEN_TRACKS_MS = 600;

    const LIKE_ARIA = ["Like", "Нравится"];
    const CONTEXT_MENU_ARIA = [
        "Context menu",
        "Контекстное меню",
        "Меню",
    ];
    const ADD_TO_PLAYLIST = ["Add to playlist", "Добавить в плейлист"];

    /** Default title of the playlist you already created (override with window.__YM_PLAYLIST_NAME). */
    const DEFAULT_TARGET_PLAYLIST_NAMES = ["New playlist"];

    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    function normalizeText(s) {
        return (s || "").replace(/\s+/g, " ").trim();
    }

    function saveTextFile(filename, text) {
        const data = text.replace(/\n/g, "\r\n");
        const blob = new Blob([data], {
            type: "text/plain;charset=utf-8",
        });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    async function waitFor(fn, timeoutMs, intervalMs = 50) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            if (window.__YM_ABORT) {
                return null;
            }
            const v = fn();
            if (v) {
                return v;
            }
            await delay(intervalMs);
        }
        return null;
    }

    function findSearchInput() {
        const inputs = [...document.querySelectorAll('input[type="search"]')];
        if (!inputs.length) {
            return document.querySelector('input[placeholder*="Трек"]')
                || document.querySelector('input[placeholder*="Track"]')
                || document.querySelector('input[type="text"]');
        }
        const byPh = inputs.find((i) =>
            /track|трек|album|альбом|artist|исполнитель/i.test(
                i.getAttribute("placeholder") || ""
            )
        );
        return byPh || inputs[0];
    }

    /** React-friendly value set for controlled inputs */
    function setInputValue(input, value) {
        if (!input) {
            return;
        }
        const proto = window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) {
            desc.set.call(input, value);
        } else {
            input.value = value;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        try {
            input.dispatchEvent(
                new InputEvent("input", {
                    bubbles: true,
                    inputType: "insertReplacementText",
                    data: value,
                })
            );
        } catch (_) {
            /* InputEvent optional */
        }
    }

    function submitSearch(input) {
        input.focus();
        input.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
            })
        );
        input.dispatchEvent(
            new KeyboardEvent("keyup", {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
            })
        );
    }

    /** Top “best track” card in search results (class hash suffix changes; prefix is stable). */
    function findBestTrackBlock() {
        return document.querySelector('[class*="SearchBestResultsTrackBlock_root"]');
    }

    function findButtonByAriaLabels(container, labels) {
        const root = container || document;
        const buttons = root.querySelectorAll("button");
        for (const b of buttons) {
            const a = (b.getAttribute("aria-label") || "").trim();
            if (labels.some((l) => a === l || a.includes(l))) {
                return b;
            }
        }
        return null;
    }

    function isRoughlyVisible(el) {
        if (!el || !(el instanceof Element)) {
            return false;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) {
            return false;
        }
        const st = getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") {
            return false;
        }
        return true;
    }

    /** Prefer Yandex popup menus; avoids clicking unrelated buttons elsewhere on the page. */
    function findMenuItemByPhrases(phrases) {
        const menuRoots = [
            ...document.querySelectorAll('[role="menu"]'),
            ...document.querySelectorAll('[role="listbox"]'),
        ].reverse();

        const tryMatch = (root) => {
            const candidates = root.querySelectorAll(
                '[role="menuitem"], [role="option"], button, a[href]'
            );
            for (const el of candidates) {
                if (!isRoughlyVisible(el)) {
                    continue;
                }
                const t = normalizeText(el.textContent);
                for (const phrase of phrases) {
                    if (t.includes(phrase)) {
                        return el;
                    }
                }
            }
            return null;
        };

        for (const menu of menuRoots) {
            if (!isRoughlyVisible(menu)) {
                continue;
            }
            const hit = tryMatch(menu);
            if (hit) {
                return hit;
            }
        }

        for (const phrase of phrases) {
            for (const el of document.querySelectorAll('[role="menuitem"], button')) {
                if (!isRoughlyVisible(el)) {
                    continue;
                }
                const t = normalizeText(el.textContent);
                if (t.includes(phrase)) {
                    return el;
                }
            }
        }
        return null;
    }

    function resolveTargetPlaylistNames() {
        const p = window.__YM_PLAYLIST_NAME;
        if (Array.isArray(p)) {
            return p.map((s) => normalizeText(String(s))).filter(Boolean);
        }
        if (typeof p === "string" && normalizeText(p)) {
            return [normalizeText(p)];
        }
        return [...DEFAULT_TARGET_PLAYLIST_NAMES];
    }

    /**
     * Clicks your existing playlist row in the submenu (exact label match preferred over substring).
     * Skips obvious “create playlist” rows if they differ by wording from your target names.
     */
    function findTargetPlaylistMenuItem(names) {
        const want = names.map((n) => normalizeText(n).toLowerCase()).filter(Boolean);
        if (!want.length) {
            return null;
        }

        const createOnlyPhrases = [
            "новый плейлист",
            "создать плейлист",
            "create playlist",
            "new playlist",
        ];

        const collectCandidates = () => {
            const out = [];
            const menuRoots = [
                ...document.querySelectorAll('[role="menu"]'),
                ...document.querySelectorAll('[role="listbox"]'),
            ].reverse();
            for (const menu of menuRoots) {
                if (!isRoughlyVisible(menu)) {
                    continue;
                }
                for (const el of menu.querySelectorAll(
                    '[role="menuitem"], [role="option"], button, a[href]'
                )) {
                    if (!isRoughlyVisible(el)) {
                        continue;
                    }
                    out.push(el);
                }
            }
            if (!out.length) {
                for (const el of document.querySelectorAll('[role="menuitem"], button')) {
                    if (isRoughlyVisible(el)) {
                        out.push(el);
                    }
                }
            }
            return out;
        };

        let best = null;
        let bestScore = 0;

        for (const el of collectCandidates()) {
            const t = normalizeText(el.textContent).toLowerCase();
            if (!t) {
                continue;
            }
            /* Don’t re-hit “Add to playlist”. */
            if (ADD_TO_PLAYLIST.some((p) => t.includes(p.toLowerCase()))) {
                continue;
            }

            for (const w of want) {
                if (t === w) {
                    return el;
                }
                if (t.includes(w)) {
                    const score = w.length >= 8 ? 3 : 2;
                    if (score > bestScore) {
                        bestScore = score;
                        best = el;
                    }
                }
            }
        }

        if (best && bestScore > 0) {
            const t = normalizeText(best.textContent).toLowerCase();
            const looksLikeGenericCreate =
                createOnlyPhrases.includes(t) && !want.includes(t);
            if (!looksLikeGenericCreate) {
                return best;
            }
            return null;
        }

        return null;
    }

    async function clickLikeOnBlock(block) {
        const btn = findButtonByAriaLabels(block, LIKE_ARIA);
        if (!btn) {
            return false;
        }
        if (btn.getAttribute("aria-pressed") === "true") {
            return true;
        }
        btn.click();
        await delay(STEP_DELAY_MS);
        return true;
    }

    async function openContextMenu(block) {
        let btn = findButtonByAriaLabels(block, CONTEXT_MENU_ARIA);
        if (!btn) {
            btn = block.querySelector('button[aria-haspopup="menu"]');
        }
        if (!btn) {
            return false;
        }
        btn.click();
        await delay(STEP_DELAY_MS);
        return true;
    }

    async function clickAddToPlaylist() {
        const el = await waitFor(
            () => findMenuItemByPhrases(ADD_TO_PLAYLIST),
            MENU_TIMEOUT_MS
        );
        if (!el) {
            return false;
        }
        el.click();
        await delay(STEP_DELAY_MS);
        return true;
    }

    async function clickTargetPlaylist(playlistNames) {
        const el = await waitFor(
            () => findTargetPlaylistMenuItem(playlistNames),
            MENU_TIMEOUT_MS
        );
        if (!el) {
            return false;
        }
        el.click();
        await delay(STEP_DELAY_MS);
        return true;
    }

    async function processOneTrack(query, playlistNames) {
        const input = findSearchInput();
        if (!input) {
            console.error("YM import: search input not found");
            return false;
        }

        setInputValue(input, "");
        await delay(80);
        setInputValue(input, query);
        await delay(120);
        submitSearch(input);
        await delay(400);

        const block = await waitFor(findBestTrackBlock, SEARCH_RESULT_TIMEOUT_MS);
        if (!block) {
            return false;
        }

        if (!(await clickLikeOnBlock(block))) {
            console.warn("YM import: Like button not found for:", query);
        }

        if (!(await openContextMenu(block))) {
            console.warn("YM import: context menu button not found for:", query);
            return false;
        }

        if (!(await clickAddToPlaylist())) {
            return false;
        }

        if (!(await clickTargetPlaylist(playlistNames))) {
            return false;
        }

        await delay(BETWEEN_TRACKS_MS);
        return true;
    }

    function getLinesFromWindow() {
        const raw = window.__YM_TRACKS;
        if (typeof raw !== "string" || !raw.trim()) {
            return null;
        }
        return raw
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
    }

    function showPastePanel() {
        return new Promise((resolve) => {
            const wrap = document.createElement("div");
            wrap.style.cssText =
                "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);" +
                "display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;";
            const box = document.createElement("div");
            box.style.cssText =
                "background:#fff;color:#111;max-width:560px;width:90%;padding:16px;border-radius:12px;" +
                "box-shadow:0 8px 32px rgba(0,0,0,.2);";
            box.innerHTML =
                "<p style=\"margin:0 0 8px;font-weight:600\">Yandex Music — playlist import</p>" +
                "<p style=\"margin:0 0 8px;font-size:13px;opacity:.85\">Paste lines from <code>vk-playlist.txt</code> (Artist - Title). Then click Start.</p>";
            const ta = document.createElement("textarea");
            ta.style.cssText =
                "width:100%;height:220px;box-sizing:border-box;font-size:12px;margin:8px 0;";
            ta.placeholder = "BIZZBA - Time Warp\n...";
            const row = document.createElement("div");
            row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:8px;";
            const cancel = document.createElement("button");
            cancel.textContent = "Cancel";
            cancel.type = "button";
            const start = document.createElement("button");
            start.textContent = "Start";
            start.type = "button";
            cancel.onclick = () => {
                document.body.removeChild(wrap);
                resolve(null);
            };
            start.onclick = () => {
                const lines = ta.value
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .filter(Boolean);
                document.body.removeChild(wrap);
                resolve(lines);
            };
            row.appendChild(cancel);
            row.appendChild(start);
            box.appendChild(ta);
            box.appendChild(row);
            wrap.appendChild(box);
            document.body.appendChild(wrap);
            ta.focus();
        });
    }

    async function main() {
        window.__YM_ABORT = false;
        let lines = getLinesFromWindow();
        if (!lines) {
            lines = await showPastePanel();
        }
        if (!lines || !lines.length) {
            alert("No tracks — set window.__YM_TRACKS or paste in the panel.");
            return;
        }

        const playlistNames = resolveTargetPlaylistNames();
        const notFound = [];
        const total = lines.length;
        console.log(
            `YM import: ${total} track(s) -> playlist "${playlistNames.join('" / "')}". Stop: window.__YM_ABORT = true`
        );

        for (let i = 0; i < lines.length; i++) {
            if (window.__YM_ABORT) {
                console.warn("YM import: aborted at", i + 1);
                break;
            }
            const q = lines[i];
            console.log(`YM import [${i + 1}/${total}]`, q);
            try {
                const ok = await processOneTrack(q, playlistNames);
                if (!ok) {
                    notFound.push(q);
                }
            } catch (e) {
                console.error("YM import error:", q, e);
                notFound.push(q);
            }
        }

        if (notFound.length) {
            saveTextFile("ym-not-found.txt", notFound.join("\n"));
            console.warn(
                `YM import: ${notFound.length} not found — downloaded ym-not-found.txt`
            );
        } else {
            console.log("YM import: all tracks processed (no misses).");
        }
    }

    main();
})();
