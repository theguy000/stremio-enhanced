#!/usr/bin/env node
// scripts/download-libmpv.js
// Downloads pre-built libmpv for the target platform/arch
// Usage: node scripts/download-libmpv.js <platform> <arch>
//
// Sources:
//   Windows: https://github.com/shinchiro/mpv-winbuild-cmake/releases
//   Linux:   mpv PPA or static build
//   macOS:   Homebrew bottle
//
// Places binaries in native/deps/<platform>-<arch>/

const { execSync } = require('child_process');
const { mkdirSync, existsSync } = require('fs');
const path = require('path');

const [,, platform, arch] = process.argv;

if (!platform || !arch) {
    console.error('Usage: node scripts/download-libmpv.js <platform> <arch>');
    process.exit(1);
}

const platformMap = { win: 'win', linux: 'linux', mac: 'mac' };
const mappedPlatform = platformMap[platform];
if (!mappedPlatform) {
    console.error(`Unknown platform: ${platform}`);
    process.exit(1);
}

const depsDir = path.join(__dirname, '..', 'native', 'deps', `${mappedPlatform}-${arch}`);
if (!existsSync(depsDir)) {
    mkdirSync(depsDir, { recursive: true });
}

console.log(`Downloading libmpv for ${mappedPlatform}-${arch}...`);

// Platform-specific download logic
switch (platform) {
    case 'win': {
        // Download from shinchiro/mpv-winbuild-cmake releases
        // Expected files: libmpv-2.dll, mpv.lib (import library)
        const releaseUrl = 'https://github.com/shinchiro/mpv-winbuild-cmake/releases';
        console.log(`TODO: Download Windows libmpv from ${releaseUrl}`);
        console.log('Expected: libmpv-2.dll in ' + depsDir);
        break;
    }
    case 'linux': {
        // Extract from distro package or build
        console.log('TODO: Download Linux libmpv.so.2');
        console.log('Expected: libmpv.so.2 in ' + depsDir);
        break;
    }
    case 'mac': {
        // Extract from Homebrew bottle
        console.log('TODO: Download macOS libmpv.2.dylib via Homebrew');
        console.log('Expected: libmpv.2.dylib in ' + depsDir);
        break;
    }
}

console.log('libmpv download step complete (stub - implement actual download logic)');
