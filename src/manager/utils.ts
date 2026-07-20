/** @file Provides various utility functions used withing signal handling code. */

import type St from 'gi://St';
import type {RoundedCornersEffect} from '../effect/rounded_corners_effect.js';
import type {
    RoundedCornerSettings,
    RoundedWindowActor,
} from '../utils/types.js';

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import {boxShadowCss} from '../utils/box_shadow.js';
import {
    APP_SHADOWS,
    ROUNDED_CORNERS_EFFECT,
    SHADOW_PADDING,
} from '../utils/constants.js';
import {readFile} from '../utils/file.js';
import {logDebug} from '../utils/log.js';
import {getPref} from '../utils/settings.js';

/**
 * Get the actor that rounded corners should be applied to.
 * In Wayland, the effect is applied to WindowActor, but in X11, it is applied
 * to WindowActor.first_child.
 *
 * @param actor - The window actor to unwrap.
 * @returns The correct actor that the effect should be applied to.
 */
export function unwrapActor(actor: RoundedWindowActor) {
    const type = actor.metaWindow.get_client_type();
    return type === Meta.WindowClientType.X11 ? actor.get_first_child() : actor;
}

/**
 * Get the correct rounded corner setting for a window (custom settings if a
 * window has custom overrides, global settings otherwise).
 *
 * @param win - The window to get the settings for.
 * @returns The matching settings object.
 */
export function getRoundedCornersCfg(win: Meta.Window) {
    const globalCfg = getPref('global-rounded-corner-settings');
    const customCfgList = getPref('custom-rounded-corner-settings');

    if (
        win.wmClass === null ||
        !customCfgList[win.wmClass] ||
        !customCfgList[win.wmClass].enabled
    ) {
        return globalCfg;
    }

    return customCfgList[win.wmClass];
}

// Weird TypeScript magic :)
type RoundedCornersEffectType = InstanceType<typeof RoundedCornersEffect>;

/**
 * Get the Clutter.Effect object for the rounded corner effect of a specific
 * window.
 *
 * @param actor - The window actor to get the effect for.
 * @returns The corresponding Clutter.Effect object.
 */
export function getRoundedCornersEffect(actor: RoundedWindowActor) {
    const win = actor.metaWindow;
    const name = ROUNDED_CORNERS_EFFECT;
    const isXwayland =
        win.get_client_type() === Meta.WindowClientType.X11 && actor.firstChild;

    return isXwayland
        ? (actor.firstChild.get_effect(name) as RoundedCornersEffectType)
        : (actor.get_effect(name) as RoundedCornersEffectType);
}

/** Compute outer bounds for rounded corners of a window
 *
 * @param actor - The window actor to compute the bounds for.
 * @param [x, y, width, height] - The content offsets of the window actor.
 */
export function computeBounds(
    actor: RoundedWindowActor,
    [x, y, width, height]: [number, number, number, number],
) {
    const bounds = {
        x1: x + 1,
        y1: y + 1,
        x2: x + actor.width + width,
        y2: y + actor.height + height,
    };

    // Kitty draws its window decoration by itself, so we need to manually
    // clip its shadow and recompute the outer bounds for it. Check wm_class
    // first to avoid reading the pref for every non-kitty window.
    if (
        actor.metaWindow.wmClass === 'kitty' &&
        actor.metaWindow.get_client_type() === Meta.WindowClientType.WAYLAND &&
        getPref('tweak-kitty-terminal')
    ) {
        const [x1, y1, x2, y2] = APP_SHADOWS.kitty;
        bounds.x1 += x1;
        bounds.y1 += y1;
        bounds.x2 -= x2;
        bounds.y2 -= y2;
    }

    return bounds;
}

/**
 * Compute the offset of actual window contents from the entire window buffer.
 *
 * @param window - The window to compute the offset for.
 * @returns The content offsets of the window (x, y, width, height).
 */
export function computeWindowContentsOffset(
    window: Meta.Window,
): [number, number, number, number] {
    const bufferRect = window.get_buffer_rect();
    const frameRect = window.get_frame_rect();
    return [
        frameRect.x - bufferRect.x,
        frameRect.y - bufferRect.y,
        frameRect.width - bufferRect.width,
        frameRect.height - bufferRect.height,
    ];
}

/**
 * Compute the offset of the shadow actor for a window.
 *
 * @param [offsetX, offsetY, offsetWidth, offsetHeight] - The content offsets of the window actor.
 */
export function computeShadowActorOffset([
    offsetX,
    offsetY,
    offsetWidth,
    offsetHeight,
]: [number, number, number, number]) {
    return [
        offsetX - SHADOW_PADDING,
        offsetY - SHADOW_PADDING,
        2 * SHADOW_PADDING + offsetWidth,
        2 * SHADOW_PADDING + offsetHeight,
    ];
}

/** Update the CSS style of a shadow actor
 *
 * @param win - The window to update the style for.
 * @param actor - The shadow actor to update the style for.
 * @param borderRadius - The border radius of the shadow actor.
 * @param shadow - The shadow settings for the window.
 * @param padding - The padding of the shadow actor.
 */
export function updateShadowActorStyle(
    win: Meta.Window,
    actor: St.Bin,
    borderRadius?: number,
    shadow = getPref('focused-shadow'),
    padding?: RoundedCornerSettings['padding'],
) {
    const globalCfg = getPref('global-rounded-corner-settings');
    const effectiveBorderRadius = borderRadius ?? globalCfg.borderRadius;
    const effectivePadding = padding ?? globalCfg.padding;

    const {left, right, top, bottom} = effectivePadding;
    const adjustedBorderRadius =
        effectiveBorderRadius * (1.0 + globalCfg.smoothing);

    actor.style = `padding: ${SHADOW_PADDING}px;`;

    const child = actor.firstChild as St.Bin;

    const hideShadowForMaximizedFullscreen =
        !getPref('keep-shadow-for-maximized-fullscreen') &&
        (win.maximizedHorizontally ||
            win.maximizedVertically ||
            win.fullscreen);

    const newChildStyle = hideShadowForMaximizedFullscreen
        ? 'opacity: 0;'
        : `background: white;
               border-radius: ${adjustedBorderRadius}px;
               ${boxShadowCss(shadow)};
               margin: ${top}px
                       ${right}px
                       ${bottom}px
                       ${left}px;`;

    // Only update style and queue a redraw when the style actually changed.
    if (child.style !== newChildStyle) {
        child.style = newChildStyle;
        child.queue_redraw();
    }
}

/**
 * Check whether a window should have rounded corners.
 *
 * @param win - The window to check.
 * @returns Whether the window should have rounded corners.
 */
export async function shouldEnableEffect(
    win: Meta.Window & {_appType?: AppType},
) {
    // Skip rounded corners for the DING (Desktop Icons NG) extension.
    //
    // https://extensions.gnome.org/extension/2087/desktop-icons-ng-ding/
    if (win.gtkApplicationId === 'com.rastersoft.ding') {
        return false;
    }

    // Skip blacklisted applications.
    if (win.wmClass === null) {
        logDebug(`Warning: wm_class_instance of ${win}: ${win.title} is null`);
        return false;
    }
    // handles blacklist / whitelist
    const isException = getPref('blacklist').includes(win.wmClass);
    const enableExceptions = getPref('whitelist');
    if (isException !== enableExceptions) {
        return false;
    }

    // Only apply the effect to normal windows (skip menus, tooltips, etc.)
    if (
        win.windowType !== Meta.WindowType.NORMAL &&
        win.windowType !== Meta.WindowType.DIALOG &&
        win.windowType !== Meta.WindowType.MODAL_DIALOG
    ) {
        return false;
    }

    // Skip libhandy/libadwaita applications according to settings.
    const appType = win._appType ?? (await getAppType(win));
    win._appType = appType; // Cache the result.
    logDebug(`Check Type of window:${win.wmClass} => ${appType}`);

    if (
        getPref('skip-libadwaita-app') &&
        appType === 'LibAdwaita' &&
        !isException
    ) {
        return false;
    }
    if (
        getPref('skip-libhandy-app') &&
        appType === 'LibHandy' &&
        !isException
    ) {
        return false;
    }

    // Skip maximized/fullscreen windows according to settings.
    const maximized = win.maximizedHorizontally || win.maximizedVertically;
    const fullscreen = win.fullscreen;
    const cfg = getRoundedCornersCfg(win);
    return (
        !(maximized || fullscreen) ||
        (maximized && !fullscreen && cfg.keepRoundedCorners.maximized) ||
        (fullscreen && cfg.keepRoundedCorners.fullscreen)
    );
}

// Brave origin apps (PWAs, site-specific browsers) use 'brave-origin' instead
// of 'brave-browser', so we match the prefix rather than the full class name.
const CHROMIUM_WM_CLASS_PATTERN =
    /^(brave-(browser|origin)|chromium|google-chrome|microsoft-edge)$/;

/**
 * Check whether a window belongs to a Chromium-based browser. These apps
 * render stale surfaces for unfocused windows after screen lock/unlock, and
 * take longer to deliver a fresh frame after unminimize.
 *
 * Deliberately wm_class-based rather than reading /proc/<pid>/maps: the
 * latter is prone to permission errors for sandboxed/other-user processes
 * (see withProcMaps below) and adds an async round-trip to a hot path.
 *
 * @param win - The window to check.
 * @returns Whether the window belongs to a Chromium-based browser.
 */
export function isChromiumWindow(win: Meta.Window): boolean {
    const wmClass = win.get_wm_class_instance();
    return wmClass !== null && CHROMIUM_WM_CLASS_PATTERN.test(wmClass);
}

type AppType = 'LibAdwaita' | 'LibHandy' | 'Other';

/**
 * Get the type of the application (LibHandy/LibAdwaita/Other).
 *
 * @param win - The window to get the type of.
 * @returns the type of the application.
 */
function getAppType(win: Meta.Window) {
    return withProcMaps<AppType>(
        win,
        contents => {
            if (contents.includes('libhandy-1.so')) {
                return 'LibHandy';
            }

            if (contents.includes('libadwaita-1.so')) {
                return 'LibAdwaita';
            }

            return 'Other';
        },
        () => 'Other',
    );
}

/**
 * Read /proc/{pid}/maps of a window and process the contents.
 * Suppresses permission errors and logs the rest.
 *
 * @param win - The window to read the maps from.
 * @param successCb - The function to run on the read contents.
 * @param errorCb - The value to run in case of an error.
 * @returns the result of the callback.
 */
async function withProcMaps<T>(
    win: Meta.Window,
    successCb: (contents: string) => T,
    errorCb: () => T,
) {
    try {
        const contents = await readFile(`/proc/${win.get_pid()}/maps`);
        return successCb(contents);
    } catch (e) {
        // /proc/<pid>/maps can fail for several expected reasons: the process
        // is owned by another user (PERMISSION_DENIED), or it exited between
        // get_pid() and the read (NOT_FOUND). Both are benign — log at debug
        // level and keep logError for anything else.
        if (
            e instanceof Gio.IOErrorEnum &&
            (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED) ||
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
        ) {
            logDebug(
                `Could not read /proc maps for ${win.wmClass}: ${e.message}`,
            );
        } else {
            logError(e);
        }

        return errorCb();
    }
}
