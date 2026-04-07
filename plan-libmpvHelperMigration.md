## Plan: libmpv Helper Migration

This main branch still only wires external playback in source. The new plan starts from that baseline and adds a new embedded playback mode where Electron owns route control and UI, while a separate native helper linked to libmpv owns decoding, rendering, and playback state.

The visual source of truth for making the embedded player look the same as Stremio is the upstream `Stremio/stremio-web` repository, especially its player route, control bar, menus, overlays, and related styles. The behavioral source of truth for commands, state, tracks, buffering, and playback semantics is the upstream `Stremio/stremio-video` repository.

## Phase 1

### Step 1 - Define the migration boundary
This branch currently exposes only external playback in [src/interfaces/ExternalPlayerTypes.ts](c:\Users\istiak\git\stremio-enhanced\src\interfaces\ExternalPlayerTypes.ts), [src/constants/index.ts](c:\Users\istiak\git\stremio-enhanced\src\constants\index.ts), [src/preload/api/externalPlayer.ts](c:\Users\istiak\git\stremio-enhanced\src\preload\api\externalPlayer.ts), and [src/controllers/externalPlayerController.ts](c:\Users\istiak\git\stremio-enhanced\src\controllers\externalPlayerController.ts). Add a new embedded-helper playback mode alongside the existing disabled, VLC, and external MPV modes, without overloading the current external-only setting.

### Step 2 - Lock the upstream references
Use `Stremio/stremio-web` as the canonical reference for how the player should look and feel, with focus on the Player route, `styles.less`, `ControlBar`, `SeekBar`, `OptionsMenu`, `SubtitlesMenu`, `AudioMenu`, `SpeedMenu`, `Error`, `NextVideoPopup`, `SideDrawer`, and nav-bar layers. Use `Stremio/stremio-video` as the reference for player-state shape, commands, track semantics, buffering, and end-of-playback behavior.

### Step 3 - Intercept playback before the Stremio player takes over
Reuse the route interception pattern in [src/preload/ui/externalPlayerInterceptor.ts](c:\Users\istiak\git\stremio-enhanced\src\preload\ui\externalPlayerInterceptor.ts) and the hashchange lifecycle in [src/preload/index.ts](c:\Users\istiak\git\stremio-enhanced\src\preload\index.ts), but redirect the embedded path from `#/player` into a private app-controlled embedded-player route. Read stream and metadata through [src/utils/PlaybackState.ts](c:\Users\istiak\git\stremio-enhanced\src\utils\PlaybackState.ts).

### Step 4 - Define the helper architecture
Implement the playback backend as a separate native helper executable linked to libmpv instead of a renderer-loaded native library. Electron main should launch, supervise, and kill the helper. Preload should never talk to libmpv directly.

### Step 5 - Define the IPC contract
Use [src/constants/index.ts](c:\Users\istiak\git\stremio-enhanced\src\constants\index.ts) as the source of truth for embedded-playback channels. Add typed requests and events for session startup, surface attachment, bounds updates, load, play, pause, seek, volume, mute, speed, track changes, fullscreen, stop, shutdown, state updates, buffering, errors, and diagnostics.

### Step 6 - Add the main-process supervisor
Build a main-process controller beside [src/controllers/externalPlayerController.ts](c:\Users\istiak\git\stremio-enhanced\src\controllers\externalPlayerController.ts) and initialize it from [src/main.ts](c:\Users\istiak\git\stremio-enhanced\src\main.ts). It should own helper lifecycle, path resolution, restart rules, log capture, crash detection, and cleanup.

### Step 7 - Reuse the repo runtime layout
Use [src/core/Properties.ts](c:\Users\istiak\git\stremio-enhanced\src\core\Properties.ts) and [src/utils/StreamingServer.ts](c:\Users\istiak\git\stremio-enhanced\src\utils\StreamingServer.ts) as the model for helper binaries, runtime files, logs, crash dumps, temporary sockets, and session state.

### Step 8 - Validate native surface hosting on all desktop platforms
Run a technical spike on Windows, Linux, and macOS to prove the Electron window can host a helper-owned native video surface, resize it correctly, survive fullscreen transitions, and tear it down cleanly.

### Milestone - Core embedded architecture proven
Exit criteria: playback interception works, the helper contract is defined, the helper supervisor exists, and native surface hosting is proven on all target platforms.

### Git checkpoint
Create or stay on the `libmpv` branch, commit the completed Phase 1 work, and push that branch to GitHub once the milestone is complete.

## Phase 2

### Step 1 - Build the app-owned embedded player shell
Add a dedicated player shell in preload rather than patching the live Stremio Web DOM. Mount and destroy it from [src/preload/index.ts](c:\Users\istiak\git\stremio-enhanced\src\preload\index.ts) and [src/preload/ui/externalPlayerInterceptor.ts](c:\Users\istiak\git\stremio-enhanced\src\preload\ui\externalPlayerInterceptor.ts).

### Step 2 - Mirror the Stremio player layout
Use `Stremio/stremio-web` as the shell blueprint for the nav-bar layer, control-bar layer, menu layer, side-drawer layer, error layer, buffering layer, and indicator positioning. The shell should look the same as Stremio even though it is independently rendered.

### Step 3 - Add the video-surface container and bounds sync
Reserve a specific rectangle inside the shell for video. Preload should measure that rectangle and send throttled bounds updates through Electron main to the helper whenever layout, resize, fullscreen, or zoom changes affect geometry.

### Step 4 - Make helper state authoritative
Render current position, duration, paused state, buffering, EOF, errors, track availability, and fullscreen from helper events rather than DOM media APIs. `Stremio/stremio-video` should be the behavior reference.

### Step 5 - Keep external players as separate supported modes
Do not remove or weaken the current external player flow in [src/controllers/externalPlayerController.ts](c:\Users\istiak\git\stremio-enhanced\src\controllers\externalPlayerController.ts) and [src/preload/ui/externalPlayerInterceptor.ts](c:\Users\istiak\git\stremio-enhanced\src\preload\ui\externalPlayerInterceptor.ts). Embedded-helper failures should surface explicit errors rather than silently falling back.

### Milestone - Embedded shell usable end to end
Exit criteria: the app-owned shell renders, matches the Stremio layout direction, stays in sync with helper state, and coexists cleanly with external-player modes.

### Git checkpoint
Commit the completed Phase 2 work on `libmpv` and push the branch to GitHub after the milestone is met.

## Phase 3

### Step 1 - Package the helper and libmpv runtime explicitly
Update [package.json](c:\Users\istiak\git\stremio-enhanced\package.json) so the build explicitly includes the helper executable and the correct libmpv runtime payload outside asar.

### Step 2 - Add packaged build validation
Extend local packaging verification around [package.json](c:\Users\istiak\git\stremio-enhanced\package.json) so the helper is confirmed outside asar, launches correctly, and can be discovered by the packaged app on Windows, Linux, and macOS.

### Step 3 - Add observability and recovery paths
Add clear diagnostics for helper launch failure, missing libmpv runtime files, attach-surface failure, playback startup failure, and unexpected helper exit.

### Milestone - Cross-platform packaging stable
Exit criteria: packaged builds can locate the helper correctly, launch playback reliably, and surface actionable errors on all target platforms.

### Git checkpoint
Commit the completed Phase 3 work on `libmpv` and push the branch to GitHub after the milestone is met.

## Phase 4

### Step 1 - Restore feature parity for tracks and subtitles
Add audio-track and subtitle menus, playback speed, richer fullscreen behavior, and later advanced transport features. Use `Stremio/stremio-web` as the UI reference and `Stremio/stremio-video` as the behavior reference.

### Step 2 - Rework browser-video-dependent integrations
Audit [src/utils/EmbeddedSubtitles.ts](c:\Users\istiak\git\stremio-enhanced\src\utils\EmbeddedSubtitles.ts), [src/preload/ui/discordTracker.ts](c:\Users\istiak\git\stremio-enhanced\src\preload\ui\discordTracker.ts), and [src/core/DiscordPresence.ts](c:\Users\istiak\git\stremio-enhanced\src\core\DiscordPresence.ts) so they consume helper playback state rather than a DOM video element.

### Milestone - Feature parity layer integrated
Exit criteria: the embedded player supports the core track, subtitle, speed, fullscreen, and integration flows needed for daily use.

### Git checkpoint
Commit the completed Phase 4 work on `libmpv` and push the branch to GitHub after the milestone is met.

## Phase 5

### Step 1 - Run a dedicated parity pass against Stremio
Compare the embedded shell directly against `Stremio/stremio-web` and close the remaining gaps in layout states, hover behavior, transitions, error presentation, menus, overlays, next-video UI, side drawer, and fullscreen behavior.

### Step 2 - Finalize rollout quality
Confirm stability, polish edge cases, and keep the helper-backed player aligned with `Stremio/stremio-video` semantics so future player maintenance stays predictable.

### Milestone - libmpv player ready for sustained development
Exit criteria: the embedded player is stable, visually close to Stremio, and maintainable as a first-class playback path in this repo.

### Git checkpoint
Commit the completed Phase 5 work on `libmpv` and push the branch to GitHub after the milestone is met.

## Relevant files and repos

- [src/main.ts](c:\Users\istiak\git\stremio-enhanced\src\main.ts) — BrowserWindow lifecycle, controller initialization, shutdown hooks, and the main place to supervise a helper process
- [src/preload/index.ts](c:\Users\istiak\git\stremio-enhanced\src\preload\index.ts) — preload startup, hashchange lifecycle, and the entry point for mounting or destroying an app-owned embedded player shell
- [src/preload/ui/externalPlayerInterceptor.ts](c:\Users\istiak\git\stremio-enhanced\src\preload\ui\externalPlayerInterceptor.ts) — current playback interception logic and the best reuse point for redirecting into a dedicated helper-backed route
- [src/utils/PlaybackState.ts](c:\Users\istiak\git\stremio-enhanced\src\utils\PlaybackState.ts) — canonical source for stream URL and metadata at route interception time
- [src/controllers/externalPlayerController.ts](c:\Users\istiak\git\stremio-enhanced\src\controllers\externalPlayerController.ts) — reference pattern for keeping player launch and lifecycle management in the main process
- [src/preload/api/externalPlayer.ts](c:\Users\istiak\git\stremio-enhanced\src\preload\api\externalPlayer.ts) — reference pattern for a typed preload-to-main playback bridge
- [src/constants/index.ts](c:\Users\istiak\git\stremio-enhanced\src\constants\index.ts) — source of truth for storage keys, IPC channel names, and future helper command and event identifiers
- [src/interfaces/ExternalPlayerTypes.ts](c:\Users\istiak\git\stremio-enhanced\src\interfaces\ExternalPlayerTypes.ts) — current playback-mode model that should expand to represent the new embedded-helper mode
- [src/core/Properties.ts](c:\Users\istiak\git\stremio-enhanced\src\core\Properties.ts) — per-user writable path conventions for logs, temp files, and helper runtime state
- [src/utils/StreamingServer.ts](c:\Users\istiak\git\stremio-enhanced\src\utils\StreamingServer.ts) — existing pattern for process management, writable runtime directories, and cross-platform binary handling
- [package.json](c:\Users\istiak\git\stremio-enhanced\package.json) — scripts plus electron-builder configuration that must explicitly package helper binaries and libmpv runtime assets
- [src/utils/EmbeddedSubtitles.ts](c:\Users\istiak\git\stremio-enhanced\src\utils\EmbeddedSubtitles.ts) — later-phase redesign candidate because it currently assumes browser-video behavior
- [src/preload/ui/discordTracker.ts](c:\Users\istiak\git\stremio-enhanced\src\preload\ui\discordTracker.ts) — later-phase redesign candidate because embedded playback will no longer be driven by a DOM video element
- [src/core/DiscordPresence.ts](c:\Users\istiak\git\stremio-enhanced\src\core\DiscordPresence.ts) — keep public Discord behavior while changing the playback event source underneath it
- Upstream visual source of truth: `Stremio/stremio-web`, especially `src/routes/Player`, its layer structure, and its player-related styles and menus
- Upstream playback-behavior reference: `Stremio/stremio-video`, especially `ShellVideo`, `StremioVideo`, and the prop, command, and track model used across player implementations

## Verification

1. Complete a per-platform spike that proves a helper-linked libmpv surface can be created, attached, resized, fullscreened, and destroyed inside the Electron window on Windows, Linux, and macOS.
2. Verify the embedded route intercepts before the Stremio player takes over, renders the dedicated shell, and tears down cleanly on route exit and app shutdown.
3. Compare the embedded shell against `Stremio/stremio-web` player states and confirm the layout, spacing, overlays, menus, and controls look materially the same.
4. Validate the IPC contract with mocked helper responses first, then with the real helper, covering startup, load, play, pause, seek, mute, volume, fullscreen, track updates, errors, and unexpected helper exit.
5. Build unpacked artifacts for Linux, macOS, and Windows and confirm the packaged app can locate the helper and libmpv runtime files outside asar on each platform.
6. Confirm that existing VLC and external MPV modes still work unchanged while embedded-helper mode is enabled separately.

## Decisions

- Target scope: all desktop platforms from the start.
- Phase 1 UI goal: a simple dedicated player shell that already follows the Stremio player’s visual structure.
- Visual source of truth: `Stremio/stremio-web`.
- Behavioral source of truth: `Stremio/stremio-video`.
- Architecture: separate native helper process linked to libmpv, supervised by Electron main, with preload talking only through Electron IPC.
- Surface strategy: app-owned embedded player route and shell instead of patching Stremio Web’s native player DOM.
- Failure strategy: show explicit embedded-player errors and keep external VLC and external MPV as independently selectable modes.
- State strategy: helper playback state is authoritative.
- Branch strategy: all milestone work lands on the `libmpv` branch and gets pushed after each milestone is complete.
