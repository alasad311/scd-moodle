// Download percentage for Squirrel.Windows updates.
//
// Squirrel (Update.exe) downloads update packages in the background but never
// reports progress to the app. It does, however, download each package
// straight into <install dir>\packages\<file name>, and the RELEASES file on
// the update feed lists every package with its exact size in bytes. So we
// read the expected sizes from RELEASES and watch the files grow on disk.

const fs = require('fs');
const path = require('path');

// "SHA1 name-or-url size" per line → [{ name, size, version, isDelta }]
function parseReleases(text) {
  return String(text)
    .replace(/\uFEFF/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3)
    .map(([, ref, size]) => {
      const name = decodeURIComponent(ref.split('?')[0].split('/').pop());
      const m = name.match(/-(\d+\.\d+\.\d+)-(full|delta)\.nupkg$/i);
      return m && { name, size: Number(size), version: m[1], isDelta: m[2].toLowerCase() === 'delta' };
    })
    .filter((e) => e && e.size > 0);
}

function newerThan(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

/**
 * Start watching an update download. Returns a stop() function.
 *   feedUrl        Squirrel feed URL (RELEASES is fetched from `${feedUrl}/RELEASES`)
 *   currentVersion version running now; only newer packages are watched
 *   packagesDir    Squirrel's packages folder
 *   fetchFn        fetch implementation (electron's net.fetch in the app)
 *   onProgress     called with { percent, receivedBytes, totalBytes } when it changes
 */
function watchUpdateDownload({ feedUrl, currentVersion, packagesDir, fetchFn, onProgress, intervalMs = 700 }) {
  let stopped = false;
  let timer = null;
  let last = -1;
  const startedAt = Date.now() - 5000; // ignore leftovers from older downloads

  (async () => {
    let entries;
    try {
      const res = await fetchFn(`${feedUrl.replace(/\/$/, '')}/RELEASES?id=progress`);
      if (!res.ok) return;
      entries = parseReleases(await res.text()).filter((e) => newerThan(e.version, currentVersion));
    } catch (_) {
      return; // no percentage; the toolbar keeps its spinner
    }
    if (stopped || !entries.length) return;

    const tick = () => {
      if (stopped) return;
      // The file being written right now is the most recently modified one.
      let active = null;
      for (const e of entries) {
        try {
          const st = fs.statSync(path.join(packagesDir, e.name));
          if (st.mtimeMs < startedAt) continue;
          if (!active || st.mtimeMs > active.mtimeMs) active = { e, mtimeMs: st.mtimeMs, size: st.size };
        } catch (_) { /* not started yet */ }
      }
      if (active) {
        const total = active.e.size;
        const received = Math.min(active.size, total);
        // Stay below 100% until Squirrel says the update is ready.
        const percent = Math.min(99, Math.floor((received / total) * 100));
        if (percent !== last) {
          last = percent;
          onProgress({ percent, receivedBytes: received, totalBytes: total });
        }
      }
      timer = setTimeout(tick, intervalMs);
    };
    tick();
  })();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = { watchUpdateDownload, parseReleases };
