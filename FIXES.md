# Fixes in this fork

This fork carries a set of fixes on top of the [original rounded-window-corners
extension](https://github.com/flexagoon/rounded-window-corners) that have not
been integrated upstream (see
[flexagoon/rounded-window-corners#144](https://github.com/flexagoon/rounded-window-corners/pull/144)).
They are documented here so users of this fork know exactly what differs from
upstream and why.

If upstream ever integrates these (or equivalent) fixes, the corresponding
entry below can be dropped.

## Chromium corner glitch on restore after app-initiated minimize

Chromium-based browsers implement their own title bar and context menu, using
`xdg_toplevel.set_minimized` to request minimize from the compositor. This is
distinct from compositor-initiated minimizes (Super+H, Super+D), which do not
exhibit the issue. When Chromium sends `xdg_toplevel.set_minimized`, the
compositor acknowledges the minimized state and Chromium stops updating its
Wayland surface buffer — the last rendered frame is held. On restore, the
stale surface causes the GLSL rounded corner shader to render with wrong
bounds, producing a visible glitch until the window receives focus and
self-corrects.

In `onUnminimize`, Chromium windows outside the magic lamp path are detected
and a 250ms `refreshRoundedCorners` call is scheduled. This gives Chromium
time to deliver a fresh post-restore frame before the shader uniforms are
recomputed. The effect is never disabled during the minimize state, so there
is no hover delay in the overview and intermediate focus/size change
callbacks are not blocked.

**Known limitation:** the overview thumbnail for a minimized Chromium window
shows square corners — the `Shell.GLSLEffect` shader does not apply through
`Clutter.Clone`, so the raw window surface is rendered. This is a
compositor-level constraint that cannot be addressed from the extension side.

Commit: [`eba3c9d`](https://github.com/GrzegorzKozub/rounded-window-corners-fork/commit/eba3c9d2b1615077891f6672caf5759ad938c28e)

## Chromium effect reapply after screen lock/unlock

GNOME Shell disables and re-enables extensions during screen lock/unlock.
When the extension re-enables, Chromium-based browsers (Brave, Chrome, Edge)
may render stale surfaces for unfocused windows. The compositor skips
repainting GLSL effects for these windows, resulting in scrambled borders and
a doubled frame.

After applying effects to existing windows on re-enable, the extension waits
250ms for surfaces to settle, then briefly focuses each unfocused Chromium
window (detected by `wm_class`) to force the compositor to repaint the GLSL
effect, then restores focus to the original window. `onFocusChanged` was also
promoted from `refreshShadow` to `refreshRoundedCorners` so that any focus
change recomputes shader bounds, not just the shadow.

Commits:
[`2503b48`](https://github.com/GrzegorzKozub/rounded-window-corners-fork/commit/2503b485cd2d0a33262375988fba1d64e9b49528),
[`390b018`](https://github.com/GrzegorzKozub/rounded-window-corners-fork/commit/390b018e4072f9d8b926da9de7bda9f21c036185)

## Overview shadow allocation crash

Guards against zero frame width in `vfunc_allocate` on the overview shadow
clone, which previously caused `NaN` values in the allocation box and
triggered Clutter assertion failures.

Commit: [`8af15df`](https://github.com/GrzegorzKozub/rounded-window-corners-fork/commit/8af15df1be5399fbefd8e6d966271ebe525bf88b)

## Silence expected permission errors on `/proc/<pid>/maps`

`getAppType` reads `/proc/<pid>/maps` to detect LibHandy / LibAdwaita
windows. For processes owned by another user (flatpak sandboxes, root-owned
apps), the file is unreadable and GIO raises `PERMISSION_DENIED`. The
existing fallback already handled the outcome, but the error was logged with
a full stack trace on every such window. `PERMISSION_DENIED` and `NOT_FOUND`
are now treated as expected and logged at debug level; `logError` is kept
for everything else.

Commit: [`29f8971`](https://github.com/GrzegorzKozub/rounded-window-corners-fork/commit/29f8971dc8cf14b571ef2a7ca71d23ec3df61722)

## `clutter_actor_node_new` crash on new browser windows (GNOME 50.2)

On mutter 50.2 (Wayland-only), `actor.metaWindow` can be null during window
actor lifecycle transitions. Previously, `applyEffectTo` connected
`notify::size` and `size-changed` before checking `actor.metaWindow`. When
`metaWindow` was null, the resulting TypeError aborted the function
mid-way, leaving size signals connected but the effect never added. On the
next `notify::size` (fired during Clutter layout), `onAddEffect` was called
while the actor was mid-paint, corrupting the effect's actor pointer and
causing `clutter_actor_node_new(NULL)` → SIGABRT.

`actor.metaWindow` is now guarded before connecting any signals in
`applyEffectTo`, so the function either completes fully or returns early
with nothing connected. `actor` from `get_compositor_private()` is also
null-guarded in the `window-created` handler, and a fresh actor is
re-fetched in the `wm-class` deferred callback instead of using the
captured (potentially stale) reference.

Commit: [`9b3c201`](https://github.com/GrzegorzKozub/rounded-window-corners-fork/commit/9b3c201bdb636fc2e513b31eee6337a78a8536be)

## Effect add/remove mid-paint crash (GNOME 50.2, `keepRoundedCorners.maximized = false`)

A second crash path in the same assertion (`clutter_actor_node_new(NULL)`)
was observed after the null-`metaWindow` fix above was deployed. Root cause:
Clutter emits `notify::size` and `size-changed` during a layout pass that
runs inside a paint frame — specifically during
`meta_window_actor_paint_to_content`, which GNOME Shell calls to capture a
window snapshot at the start of the maximize animation.

With `keepRoundedCorners.maximized = false` (the default), the `notify::size`
callback triggered `refreshRoundedCorners` → `onRemoveEffect` for the
newly-maximized window. `onRemoveEffect` called `actor.remove_effect_by_name()`
while `CLUTTER_ACTOR_IN_PAINT` was set, which corrupted the
`RoundedCornersEffect`'s actor pointer via `clutter_actor_meta_set_actor`.
The subsequent `clutter_actor_continue_paint` call then hit
`clutter_actor_node_new(NULL)` → SIGABRT.

All seven signal callbacks in `applyEffectTo`, and the two deferred-apply
callbacks in `enableEffect`, are now wrapped with
`GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, ...)`. This pushes effect
add/remove out of any active paint frame into the next GLib main loop
iteration, where it is safe to modify the actor's effect list.

Commit: [`3f31e0d`](https://github.com/GrzegorzKozub/rounded-window-corners-fork/commit/3f31e0d25d0510bf7b3b56f33137dfe9fcaf9e60)

## Performance improvements

Several hot paths were re-reading GSettings per-frame or per-event. Each
`getPref()` call deserializes through D-Bus and GLib Variant unpacking,
which adds up quickly during shader updates and resize/focus events.

- Deserialized pref values are now cached, invalidated automatically via the
  GSettings `changed` signal. This eliminates repeated unpacks for
  `debug-mode` (hit from `logDebug` in every hot-path statement),
  `blacklist`/`whitelist` (read per `shouldEnableEffect`),
  `keep-shadow-for-maximized-fullscreen`, `tweak-kitty-terminal`, and the
  shadow dictionaries.
- `updateShadowActorStyle` now reads `global-rounded-corner-settings` once
  and derives `borderRadius`, `padding`, and `smoothing` from it, instead of
  4 separate `getPref` calls.
- `computeBounds` now compares `wm_class` first, so non-kitty windows skip
  the `getPref` entirely.

Commit: [`4b3dd2c`](https://github.com/GrzegorzKozub/rounded-window-corners-fork/commit/4b3dd2c1526746e17130cd40e84c6ca1fbaffbe7)
