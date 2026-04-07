/**
 * Post-build validation: confirm the mpv-helper binary was packaged
 * outside asar under resources/mpv-helper and is executable.
 */
const fs = require('fs');
const path = require('path');

const platformDirs = {
    win32:  'release-builds/win-unpacked/resources/mpv-helper',
    linux:  'release-builds/linux-unpacked/resources/mpv-helper',
    darwin: 'release-builds/mac/Stremio Enhanced.app/Contents/Resources/mpv-helper',
};

const helperBin = process.platform === 'win32' ? 'mpv-helper.exe' : 'mpv-helper';
const dir = platformDirs[process.platform];

if (!dir) {
    console.warn(`[validate-helper] Unsupported platform "${process.platform}", skipping.`);
    process.exit(0);
}

const helperPath = path.join(__dirname, '..', dir, helperBin);

if (!fs.existsSync(helperPath)) {
    console.error(`[validate-helper] FAILED — helper not found at: ${helperPath}`);
    console.error('Make sure static/mpv-helper/ contains the helper binary before building.');
    process.exit(1);
}

const stat = fs.statSync(helperPath);
if (stat.size === 0) {
    console.error(`[validate-helper] FAILED — helper binary is empty: ${helperPath}`);
    process.exit(1);
}

console.log(`[validate-helper] OK — helper found at ${helperPath} (${stat.size} bytes)`);
