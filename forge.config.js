// Electron Forge build configuration.
//
// Small Windows updates (delta packages)
// ──────────────────────────────────────
// Squirrel.Windows can ship "delta" updates that contain only what changed
// since the previous release. But it never binary-patches the large main
// executable: if scd-moodle.exe differs by even one byte, the whole ~170 MB
// file goes into the delta. Two things changed it on every release:
//   1. the version number stamped into the .exe's file properties, and
//   2. a checksum of app.asar that the packager embeds into the .exe.
// So on Windows we stamp a FIXED file version (the app's real version still
// comes from package.json, which is what the toolbar, About box and Squirrel
// use) and ship the app code as plain files instead of an asar archive. The
// .exe is then byte-identical between releases and a typical update is just
// the changed app files (kilobytes) instead of the full ~100 MB package.
//
// The release workflow sets SQUIRREL_REMOTE_RELEASES to the previous
// release's download folder so Squirrel can compute the delta against it.

// Feeds
// ─────
// From 1.1.6 the app reads updates straight from the latest GitHub release
// (https://github.com/<repo>/releases/latest/download/RELEASES), where the
// relative package names in RELEASES resolve to the release's own files.
// Copies on 1.1.5 or older still ask update.electronjs.org, which turns only
// the FIRST package name in RELEASES into a download link; every other line
// points nowhere. So reorderReleases() below puts this version's full package
// first: those older copies try the delta, fail instantly, and fall back to
// the full package (as Squirrel always does), while 1.1.6+ gets the delta.

const fs = require('fs');
const path = require('path');

function reorderReleases(releasesPath, version) {
  const text = fs.readFileSync(releasesPath, 'utf8').replace(/\uFEFF/g, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const fullName = `-${version}-full.nupkg`;
  const first = lines.filter((l) => l.includes(fullName));
  if (first.length !== 1) throw new Error(`RELEASES: expected one ${fullName} line, got ${first.length}`);
  const ordered = [...first, ...lines.filter((l) => !l.includes(fullName))];
  fs.writeFileSync(releasesPath, ordered.join('\r\n'));
  return ordered;
}

const isWindowsBuild = process.platform === 'win32';

// Never change this: it must stay constant for deltas to stay small.
const WINDOWS_EXE_FILE_VERSION = '1.0.0';

module.exports = {
  packagerConfig: {
    name: 'SCD Moodle',
    executableName: 'scd-moodle',
    icon: './assets/icon',
    asar: !isWindowsBuild,
    ...(isWindowsBuild
      ? { appVersion: WINDOWS_EXE_FILE_VERSION, buildVersion: WINDOWS_EXE_FILE_VERSION }
      : {}),
    extraResource: [],
    ignore: [
      /node_modules\/electron$/,
      /^\/\.git/,
      /^\/\.github/,
      /^\/\.claude/,
      /^\/out/,
      /^\/forge\.config\.js$/,
      // update-electron-app (removed in 1.1.3) shipped a bundled Yarn whose
      // "powershell -ExecutionPolicy Bypass" text tripped antivirus. Keep
      // excluding any bundled .yarn just in case.
      /^\/node_modules\/[^/]+\/\.yarn(\/|$)/,
      /\.yarnrc\.yml$/,
      // tests, docs and tooling config from dependencies
      /^\/node_modules\/(.+\/)?(test|tests|__tests__|\.github)(\/|$)/,
      /^\/node_modules\/.+\.(md|markdown|map|ts)$/,
      /^\/node_modules\/.+\/(karma\.conf\.js|jest\.config\.js|\.eslintrc[^/]*|\.jsfmtrc|\.travis\.yml|appveyor\.yml|\.coveralls\.yml|Makefile)$/,
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'scd_moodle',
        authors: 'SCD',
        description: 'SCD Moodle – incognito browser for moodle.scd.edu.om',
        setupIcon: './assets/icon.ico',
        iconUrl: 'https://raw.githubusercontent.com/alasad311/scd-moodle/main/assets/icon.ico',
        ...(process.env.SQUIRREL_REMOTE_RELEASES
          ? { remoteReleases: process.env.SQUIRREL_REMOTE_RELEASES }
          : {}),
      },
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'SCD Moodle',
        format: 'ULFO',
        icon: './assets/icon.icns',
      },
    },
  ],
  hooks: {
    postMake: async (_config, makeResults) => {
      for (const result of makeResults) {
        for (const artifact of result.artifacts) {
          if (path.basename(artifact) === 'RELEASES') {
            const lines = reorderReleases(artifact, result.packageJSON.version);
            console.log(`RELEASES (${lines.length} entries), first: ${lines[0]}`);
          }
        }
      }
      return makeResults;
    },
  },
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: { owner: 'alasad311', name: 'scd-moodle' },
        draft: true,
        prerelease: false,
      },
    },
  ],
};
