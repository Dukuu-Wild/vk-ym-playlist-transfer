/**
 * VK Music — export playlist as "Artist - Title" (browser console or bookmarklet).
 * Updated for the current SPA (vkit audio rows + data-testid attributes).
 */
(async () => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    /** Scroll until the page stops growing (lazy-loaded track list). */
    async function scrollPlaylist() {
        const maxRounds = 200;
        let lastHeight = 0;
        let sameCount = 0;

        for (let i = 0; i < maxRounds; i++) {
            const el = document.scrollingElement || document.documentElement;
            const h = el.scrollHeight;
            window.scrollTo(0, h);
            await delay(450);

            const newH = el.scrollHeight;
            if (newH === lastHeight) {
                sameCount += 1;
                if (sameCount >= 3) {
                    break;
                }
            } else {
                sameCount = 0;
                lastHeight = newH;
            }
        }
    }

    function normalizeText(s) {
        return (s || "").replace(/[\s\n]+/g, " ").trim();
    }

    function parsePlaylistNew() {
        const rows = document.querySelectorAll(
            '[data-testid="MusicPlaylistTracks_MusicTrackRow"]'
        );
        return [...rows].map((row) => {
            const artist = normalizeText(
                row.querySelector('[data-testid="MusicTrackRow_Authors"]')?.textContent
            );
            const title = normalizeText(
                row.querySelector('[data-testid="MusicTrackRow_Title"]')?.textContent
            );
            if (artist && title) {
                return `${artist} - ${title}`;
            }
            return title || artist;
        }).filter(Boolean);
    }

    /** Previous VK markup (fallback if you saved an old page or A/B still serves legacy rows). */
    function parsePlaylistLegacy() {
        return [...document.querySelectorAll(".audio_row__performer_title")].map(
            (row) => {
                const artist = normalizeText(
                    row.querySelector(".audio_row__performers")?.textContent
                );
                const title = normalizeText(
                    row.querySelector(".audio_row__title")?.textContent
                );
                if (artist && title) {
                    return `${artist} - ${title}`;
                }
                return title || artist;
            }
        ).filter(Boolean);
    }

    function parsePlaylist() {
        const next = parsePlaylistNew();
        if (next.length) {
            return next;
        }
        return parsePlaylistLegacy();
    }

    function saveToFile(filename, content) {
        const data = content.replace(/\n/g, "\r\n");
        const blob = new Blob([data], { type: "text/plain;charset=utf-8" });
        const link = document.createElement("a");
        link.download = filename;
        link.href = URL.createObjectURL(blob);
        link.target = "_blank";
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }

    await scrollPlaylist();
    const list = parsePlaylist();

    if (list.length === 0) {
        alert("Music not found (open a VK playlist page with tracks loaded).");
    } else {
        saveToFile("vk-playlist.txt", list.join("\n"));
    }
})();
