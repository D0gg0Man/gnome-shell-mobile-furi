import AccountsService from 'gi://AccountsService';
import Cogl from 'gi://Cogl';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Signals from '../misc/signals.js';

import * as GnomeSession from '../misc/gnomeSession.js';
import * as OVirt from '../gdm/oVirt.js';
import * as LoginManager from '../misc/loginManager.js';
import * as LayoutManager from './layout.js';
import * as Lightbox from './lightbox.js';
import * as Main from './main.js';
import * as Overview from './overview.js';
import * as MessageTray from './messageTray.js';
import * as ShellDBus from './shellDBus.js';
import * as SmartcardManager from '../misc/smartcardManager.js';

import {adjustAnimationTime} from '../misc/animationUtils.js';

const SCREENSAVER_SCHEMA = 'org.gnome.desktop.screensaver';
const LOCK_ENABLED_KEY = 'lock-enabled';
const LOCK_DELAY_KEY = 'lock-delay';

const LOCKDOWN_SCHEMA = 'org.gnome.desktop.lockdown';
const DISABLE_LOCK_KEY = 'disable-lock-screen';

const LOCKED_STATE_STR = 'screenShield.locked';

const USER_IDLE_FADE_OUT_TIME_FROM_SESSION = 10000;
const SHIELD_SLIDE_UP_TIME = 300;

/**
 * If you are setting org.gnome.desktop.session.idle-delay directly in dconf,
 * rather than through System Settings, you also need to set
 * org.gnome.settings-daemon.plugins.power.sleep-display-ac and
 * org.gnome.settings-daemon.plugins.power.sleep-display-battery to the same value.
 * This will ensure that the screen blanks at the right time when it fades out.
 * https://bugzilla.gnome.org/show_bug.cgi?id=668703 explains the dependency.
 */
export class ScreenShield extends Signals.EventEmitter {
    constructor() {
        super();

        this.actor = Main.layoutManager.screenShieldGroup;
        this.actor.reactive = true;
        this.actor.style="background-color: #191919;";

        this._lockScreenState = MessageTray.State.HIDDEN;
        this._lockScreenGroup = new St.Widget({
            x_expand: true,
            y_expand: true,
            reactive: true,
            can_focus: true,
            name: 'lockScreenGroup',
            visible: false,
        });

        this._lockDialogGroup = new St.Widget({
            x_expand: true,
            y_expand: true,
            reactive: true,
            can_focus: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            name: 'lockDialogGroup',
        });

        this.actor.add_child(this._lockScreenGroup);

        this._screenSaverDBus = new ShellDBus.ScreenSaverDBus(this);

        this._smartcardManager = SmartcardManager.getSmartcardManager();
        this._smartcardManager.connect('smartcard-inserted',
            (manager, token) => {
                if (this._isLocked && token.UsedToLogin)
                    this._activateDialog();
            });

        this._credentialManagers = {};
        this.addCredentialManager(OVirt.SERVICE_NAME, OVirt.getOVirtCredentialsManager());

        this._loginManager = LoginManager.getLoginManager();

        this._loginSession = null;
        this._getLoginSession();

        this._settings = new Gio.Settings({schema_id: SCREENSAVER_SCHEMA});

        this._lockSettings = new Gio.Settings({schema_id: LOCKDOWN_SCHEMA});

        this._isModal = false;
        this._isGreeter = false;
        this._isActive = false;
        this._isLocked = false;
        this._activationTime = 0;

        this._windowTracker = Shell.WindowTracker.get_default();
        this._windowTracker.connect('tracked-windows-changed', this._appStateChanged.bind(this));

        global.display.connect('window-created', () => GLib.idle_add(0, () => {
            this._appStateChanged();

            return GLib.SOURCE_REMOVE;
        }));

        this._lockscreenOverlayStack = [];
        this._lockscreenOverlayGroup = new Clutter.Actor({

        });
        this._lockscreenOverlayGroup.add_constraint(new LayoutManager.MonitorConstraint({
            primary: true,
            work_area: true,
        }));
        this._lockDialogGroup.connect('notify::translation-x', () => {
            this._lockscreenOverlayGroup.translation_x = this._lockDialogGroup.translation_x + Main.layoutManager.primaryMonitor.width;
        });
        this._lockscreenOverlayGroup.translation_x = this._lockDialogGroup.translation_x + Main.layoutManager.primaryMonitor.width;

        this.actor.add_child(this._lockscreenOverlayGroup);
        this.actor.add_child(this._lockDialogGroup);

        this._showingOverlayGroup = false;

        this._panGesture = new Clutter.PanGesture({
            pan_axis: Clutter.PanAxis.X,
            max_n_points: 1,
            name: 'lockscreen window pan gesture',
        });
        this._panGesture.connect('may-recognize', this._panMayRecognize.bind(this));
        this._panGesture.connect('recognize', this._panBegin.bind(this));
        this._panGesture.connect('pan-update', this._panUpdate.bind(this));
        this._panGesture.connect('end', this._panEnd.bind(this));
        this._panGesture.connect('cancel', this._panCancel.bind(this));
        this.actor.add_action(this._panGesture);

        Main.wm.addKeybinding(
            'power-button',
            new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'}),
            Meta.KeyBindingFlags.BINDING_BUILTIN |
            Meta.KeyBindingFlags.BINDING_NON_MASKABLE |
            Meta.KeyBindingFlags.TRIGGER_RELEASE,
            Shell.ActionMode.ALL,
            this._handlePowerButtonEvent.bind(this),
        );
    }

    _handlePowerButtonEvent(display, window, event, binding) {
        log('_powerButtonEvent', display, window, event, binding)

        if (event.get_flags() !== Clutter.EventFlags.NONE)
            return;

        const type = event.type();
        if (type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE)
            return;

        Main.powerManager.powerButtonEvent(event);
    }

    _panMayRecognize(gesture) {
        if (this._showingOverlayGroup) {
            const beginX = gesture.get_begin_centroid().x;
            return beginX < Main.layoutManager.primaryMonitor.x + 30;
        } else {
            if (this._lockscreenOverlayStack.length === 0)
                return false;

            this._prepareLockscreenOverlay();
        }

        return true;
    }

    _panBegin(gesture) {
        this._panWidth = Main.layoutManager.primaryMonitor.width;
    }

    _panUpdate(gesture) {
        const [latestDeltaVec] = gesture.get_delta();

        this._lockDialogGroup.translation_x += latestDeltaVec.get_x();
        if (this._lockDialogGroup.translation_x > 0)
            this._lockDialogGroup.translation_x = 0;
    }

    _panEnd(gesture) {
        const velocityX = gesture.get_velocity().get_x();

        if (this._showingOverlayGroup) {
            const remainingWidth = this._panWidth - (this._panWidth + this._lockDialogGroup.translation_x);
            const gestureSuccess =
                velocityX > 0.9 || (remainingWidth < this._panWidth * 0.75 && velocityX >= 0);

            if (gestureSuccess) {
                this._lockDialogGroup.ease({
                    translation_x: 0,
                    duration: Math.clamp(remainingWidth / Math.abs(velocityX), 160, 450),
                    mode: Clutter.AnimationMode.EASE_OUT_EXPO,
                    onComplete: () => {
                        this._showingOverlayGroup = false;
//                        overlay.emit_closed();
                    },
                });
            } else {
                this._lockDialogGroup.ease({
                    translation_x: -this._panWidth,
                    duration: Math.clamp((this._panWidth - remainingWidth) / Math.abs(velocityX), 100, 250),
                    mode: Clutter.AnimationMode.EASE_OUT_QUINT,
                });
            }
        } else {
            const remainingWidth = this._panWidth + this._lockDialogGroup.translation_x;
            const gestureSuccess =
                velocityX < -0.9 || (remainingWidth < this._panWidth * 0.75 && velocityX <= 0);

            if (gestureSuccess) {
                this._lockDialogGroup.ease({
                    translation_x: -this._panWidth,
                    duration: Math.clamp(remainingWidth / Math.abs(velocityX), 160, 450),
                    mode: Clutter.AnimationMode.EASE_OUT_EXPO,
                    onComplete: () => {
                        this._showingOverlayGroup = true;
                    },
                });
            } else {
                this._lockDialogGroup.ease({
                    translation_x: 0,
                    duration: Math.clamp((this._panWidth - remainingWidth) / Math.abs(velocityX), 100, 250),
                    mode: Clutter.AnimationMode.EASE_OUT_QUINT,
                });
            }
        }
    }

    _panCancel(gesture) {
        if (this._showingOverlayGroup)
            this._lockDialogGroup.translation_x = -this._panWidth;
        else
            this._lockDialogGroup.translation_x = 0;
    }

    async _getLoginSession() {
        this._loginSession = await this._loginManager.getCurrentSessionProxy();
        this._loginSession.connectSignal('Lock',
            () => this.lock(false));
        this._loginSession.connectSignal('Unlock',
            () => this.deactivate(false));
    }

    _showSurfaceOverlayView(show, animate = true) {
        this._lockDialogGroup.ease({
            translation_x: show ? -Main.layoutManager.primaryMonitor.width : 0,
            duration: animate ? 350 : 0,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            onComplete: () => {
                this._showingOverlayGroup = show;
            },
        });
    }

    _lockscreenOverlayCreated(overlay) {
        this._lockscreenOverlayStack.push(overlay);

        overlay.surface.connect('destroy', () => {
log("SURFACEOVERLAY: destroyyyyyy");
            if (overlay.activeData) {
                // let's not reparent during destroy
                delete overlay.activeData;

                //this._deactivateLockscreenOverlay(overlay);
            }

            this._lockscreenOverlayStack.splice(this._lockscreenOverlayStack.indexOf(overlay), 1);

            if (this._showingOverlayGroup)
                this._showSurfaceOverlayView(false);
        });

/*
        overlay.connect('disallowed', () => {
            if (overlay.activeData)
                this._deactivateLockscreenOverlay(overlay);

            this._lockscreenOverlayStack.splice(this._lockscreenOverlayStack.indexOf(overlay), 1);

            if (this._showingOverlayGroup) {
                this._lockDialogGroup.ease({
                    translation_x: 0,
                    duration: 350,
                    mode: Clutter.AnimationMode.EASE_OUT_EXPO,
                    onComplete: () => {
                        this._showingOverlayGroup = false;
                    },
                });
            }
        });
*/
        log("OVERLAY created: locked " + this._isLocked + " screen off " + (this._becameActiveId !== 0));

        if (!this._isLocked)
            return;

        // If we're locked and the screen is off, wake the screen. This will
        // in turn show the lockscreen overlay.
        if (this._becameActiveId !== 0)
            this._wakeUpScreen();
        else
            this._prepareLockscreenOverlay().catch().then(() => this._showSurfaceOverlayView(true));
    }

    _removeLockscreenOverlay(surface) {

    }

    _reparentToOriginalParent(overlay) {
        if (!overlay.activeData.origParent)
            throw new Error('This is an important one');

        this._lockscreenOverlayGroup.remove_child(overlay.surface);
        overlay.activeData.origParent.add_child(overlay.surface);

        overlay.activeData.origParent.disconnect(overlay.activeData.origParentDestroyId);
    }

    _reparentToOverlayGroup(overlay) {
        if (overlay.activeData.origParent)
            throw new Error('This is an important one');

        if (overlay.surface.get_parent() === this._lockscreenOverlayGroup)
            throw new Error('This is an important one');

        overlay.activeData.origParent = overlay.surface.get_parent();
        overlay.activeData.origParentDestroyId = overlay.activeData.origParent.connect('destroy', () => {
            log("SURFACEOVERLAY: orig parent destroyyyyyy");
            overlay.surface.destroy();
        });

        overlay.activeData.origParent.remove_child(overlay.surface);
        this._lockscreenOverlayGroup.add_child(overlay.surface);
    }

    _prepareLockscreenOverlay() {
log("LOCKSCREENOVERLAY: preparing length " + this._lockscreenOverlayStack.length);
        if (this._lockscreenOverlayStack.length === 0)
            return Promise.reject();

        const overlay = this._lockscreenOverlayStack[this._lockscreenOverlayStack.length - 1];
        if (overlay.activeData)
            return Promise.resolve();

        return new Promise((resolve, reject) => {
            let disallowedId, readyId;
/*
            disallowedId = overlay.connect('disallowed', () => {
                overlay.disconnect(readyId);
                overlay.disconnect(disallowedId);

                reject();
            });

            readyId = overlay.connect('ready', () => {
                overlay.disconnect(readyId);
                overlay.disconnect(disallowedId);

                const reqAuthId = overlay.connect('request-authenticate', () => {
                    this._showSurfaceOverlayView(false);
                });

                const reqCloseId = overlay.connect('close', async () => {
                    await this._showSurfaceOverlayView(false);
                    overlay.emit_closed();
                });
*/

                overlay.activeData = {
                    connections: [/*reqAuthId, reqCloseId*/],
                }
                this._reparentToOverlayGroup(overlay);

              /*   const vert = overlay.window.can_maximize_vertically();
                const horiz = overlay.window.can_maximize_horizontally();
                if (vert && horiz)
                    overlay.window.maximize(Meta.MaximizeFlags.BOTH);
                else if (vert) {
                    overlay.window.maximize(Meta.MaximizeFlags.VERTICAL);
                } else if (horiz) {
                    overlay.window.maximize(Meta.MaximizeFlags.HORIZONTAL);
                }
*/
                // Don't ask me why, but this is the only thing that works to make the window appear focused lol
                GLib.timeout_add(0, 400, () => {
           /*         this._dialog._promptBox.visible = false;
                    this._dialog._promptBox.visible = true;
                    this._dialog._notificationsBox.visible = false;
                    this._dialog._notificationsBox.visible = true;
*/
                    overlay.window.get_workspace().activate_with_focus(overlay.window, global.get_current_time());

                    return GLib.SOURCE_REMOVE;
                });

                resolve();
//            });

//            overlay.emit_begin_show('left');
        });
    }

    _deactivateLockscreenOverlay(overlay) {
        if (!overlay.activeData)
            throw new Error('This is an important one');

//        overlay.activeData.connections.forEach(c => overlay.disconnect(c));
        this._reparentToOriginalParent(overlay);

        delete overlay.activeData;
    }

    _appStateChanged() {
        const windows = global.get_window_actors();

        for (const window of windows) {
            const app = this._windowTracker.get_window_app(window.metaWindow);

            if (app && app.id === 'org.gnome.Calls.desktop') {
                const window = app.get_windows()[0];
                if (!window)
                    return;

                const actor = window.get_compositor_private();
                if (!actor)
                    return;

                const surfaceContainer = actor.get_first_child();
//                const surfaceContainer = actor;
                if (!surfaceContainer)
                    return;
                log("SURFACEOVERLAY: putting a calls window on top of unlockDialog, container: " + surfaceContainer);

                if (this._lockscreenOverlayStack.findIndex((o) => o.surface === surfaceContainer) !== -1)
                    return;

                const fakeOverlay = {
                    surface: surfaceContainer,
                    window,
                }

                this._lockscreenOverlayCreated(fakeOverlay);
            }
        }
    }

    _setActive(active) {
        let prevIsActive = this._isActive;
        this._isActive = active;

        if (prevIsActive !== this._isActive)
            this.emit('active-changed');
    }

    _setLocked(locked) {
        let prevIsLocked = this._isLocked;
        this._isLocked = locked;

        if (prevIsLocked !== this._isLocked)
            this.emit('locked-changed');

        if (this._loginSession)
            this._loginSession.SetLockedHintAsync(locked).catch(logError);
    }

    _activateDialog() {
        if (this._isLocked) {
            this._ensureUnlockDialog(true /* allowCancel */);
            this._dialog.activate();
        } else {
            this.deactivate(true /* animate */);
        }
    }

    _becomeModal() {
        if (this._isModal)
            return true;

        let grab = Main.pushModal(Main.uiGroup, {actionMode: Shell.ActionMode.LOCK_SCREEN});

        // We expect at least a keyboard grab here
        this._isModal = (grab.get_seat_state() & Clutter.GrabState.KEYBOARD) !== 0;
        if (this._isModal)
            this._grab = grab;
        else
            Main.popModal(grab);

        return this._isModal;
    }

    showDialog() {
        if (!this._becomeModal()) {
            // In the login screen, this is a hard error. Fail-whale
            const error = new GLib.Error(
                Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED,
                'Could not acquire modal grab for the login screen. Aborting login process.');
            global.context.terminate_with_error(error);
        }

        this.actor.show();
        this._isGreeter = Main.sessionMode.isGreeter;
        this._isLocked = true;
        this._ensureUnlockDialog(true);
    }

    _ensureUnlockDialog(allowCancel) {
        if (!this._dialog) {
            let constructor = Main.sessionMode.unlockDialog;
            if (!constructor) {
                // This session mode has no locking capabilities
                this.deactivate(true);
                return false;
            }

            this._dialog = new constructor(this._lockDialogGroup);

            if (!this._dialog.open()) {
                // This is kind of an impossible error: we're already modal
                // by the time we reach this...
                log('Could not open login dialog: failed to acquire grab');
                this.deactivate(true);
                return false;
            }

            this._wakeUpScreenId = this._dialog.connect(
                'wake-up-screen', this._wakeUpScreen.bind(this));
        }

        this._dialog.allowCancel = allowCancel;
        if (this._isGreeter)
            this._dialog.activate();
        else
            this._dialog.grab_key_focus();
        return true;
    }

    _lockScreenShown() {
        this.actor.translation_y = 0;
        this._lockScreenState = MessageTray.State.SHOWN;

        this._dialog.grab_key_focus();

        this._setActive(true);
    }

    async _wakeUpScreen() {
        if (!this.active)
            return; // already woken up, or not yet asleep

        if (this._isLocked) {
            try {
                await this._prepareLockscreenOverlay();
                this._showSurfaceOverlayView(true, false);
            } catch {}
        }

        this.emit('wake-up-screen');
    }

    get locked() {
        return this._isLocked;
    }

    get active() {
        return this._isActive;
    }

    get activationTime() {
        return this._activationTime;
    }

    deactivate(animate) {
        if (this._dialog)
            this._dialog.finish(() => this._continueDeactivate(animate));
        else
            this._continueDeactivate(animate);
    }

    _continueDeactivate(animate) {
        if (this._lockScreenState === MessageTray.State.HIDDEN)
            throw new Error("ScreenShield is already in state HIDDEN");

        this._lockScreenState = MessageTray.State.HIDING;

        if (Main.sessionMode.currentMode === 'unlock-dialog')
            Main.sessionMode.popMode('unlock-dialog');

        this.emit('wake-up-screen');

        if (this._isGreeter) {
            // We don't want to "deactivate" any more than
            // this. In particular, we don't want to drop
            // the modal, hide ourselves or destroy the dialog
            // But we do want to set isActive to false, so that
            // gnome-session will reset the idle counter, and
            // gnome-settings-daemon will stop blanking the screen

            this.actor.ease({
                translation_y: -global.stage.height,
                duration: animate ? SHIELD_SLIDE_UP_TIME : 0,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._lockScreenState = MessageTray.State.HIDDEN;
                    this._lockScreenGroup.hide();

                    this._activationTime = 0;
                    this._setActive(false);
                },
            });

            return;
        }

        if (this._dialog)
            this._dialog.popModal();

        if (this._isModal) {
            Main.popModal(this._grab);
            this._grab = null;
            this._isModal = false;
        }

        for (const overlay of this._lockscreenOverlayStack) {
            if (overlay.activeData) {
                this._deactivateLockscreenOverlay(overlay);
//                overlay.emit_authenticated();
            }
        }

        this.actor.ease({
            translation_y: -global.stage.height,
            duration: animate ? SHIELD_SLIDE_UP_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._lockScreenState = MessageTray.State.HIDDEN;
                this._lockScreenGroup.hide();

                this._completeDeactivate();
            },
        });
    }

    _completeDeactivate() {
        if (this._dialog) {
            this._dialog.destroy();
            this._dialog = null;
        }

        this.actor.hide();

        if (this._lockTimeoutId) {
            GLib.source_remove(this._lockTimeoutId);
            delete this._lockTimeoutId;
        }

        this._activationTime = 0;
        this._setActive(false);
        this._setLocked(false);
        global.set_runtime_state(LOCKED_STATE_STR, null);
    }

    activate(animate, showLater) {
        if (this._activationTime === 0)
            this._activationTime = GLib.get_monotonic_time();

        if (!this._ensureUnlockDialog(true))
            return;

        // On wayland, a crash brings down the entire session, so we don't
        // need to defend against being restarted unlocked
        if (!Meta.is_wayland_compositor())
            global.set_runtime_state(LOCKED_STATE_STR, GLib.Variant.new('b', true));

        if (!showLater) {
            this.actor.show();

            if (Main.sessionMode.currentMode !== 'unlock-dialog') {
                this._isGreeter = Main.sessionMode.isGreeter;
                if (!this._isGreeter)
                    Main.sessionMode.pushMode('unlock-dialog');
            }

            this._lockScreenGroup.show();
            this._lockScreenState = MessageTray.State.SHOWING;

            this.actor.translation_y = -global.screen_height;
            this.actor.remove_all_transitions();

            if (animate) {
                this.actor.ease({
                    translation_y: 0,
                    duration: animate ? Overview.ANIMATION_TIME : 1,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._lockScreenShown(),
                });
            } else {
                this._lockScreenShown();
            }
        }

        // We used to set isActive and emit active-changed here,
        // but now we do that from lockScreenShown, which means
        // there is a 0.3 seconds window during which the lock
        // screen is effectively visible and the screen is locked, but
        // the DBus interface reports the screensaver is off.
        // This is because when we emit ActiveChanged(true),
        // gnome-settings-daemon blanks the screen, and we don't want
        // blank during the animation.
        // This is not a problem for the idle fade case, because we
        // activate without animation in that case.
    }

    addCredentialManager(serviceName, credentialManager) {
        if (this._credentialManagers[serviceName])
            return;

        this._credentialManagers[serviceName] = credentialManager;
        credentialManager.connectObject('user-authenticated', () => {
            if (this._isLocked)
                this._activateDialog();
        }, this);
    }

    removeCredentialManager(serviceName) {
        let credentialManager = this._credentialManagers[serviceName];
        if (!credentialManager)
            return;

        credentialManager.disconnectObject(this);
        delete this._credentialManagers[serviceName];
    }

    lock(animate, showLater) {
        if (this._lockSettings.get_boolean(DISABLE_LOCK_KEY)) {
            log('Screen lock is locked down, not locking'); // lock, lock - who's there?
            return;
        }

        // Warn the user if we can't become modal
        if (!this._becomeModal()) {
            Main.notifyError(
                _('Unable to lock'),
                _('Lock was blocked by an app'));
            return;
        }

        // Clear the clipboard - otherwise, its contents may be leaked
        // to unauthorized parties by pasting into the unlock dialog's
        // password entry and unmasking the entry
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, '');
        St.Clipboard.get_default().set_text(St.ClipboardType.PRIMARY, '');

        let userManager = AccountsService.UserManager.get_default();
        let user = userManager.get_user(GLib.get_user_name());

        this.activate(animate, showLater);

        const lock = this._isGreeter
            ? true
            : user.password_mode !== AccountsService.UserPasswordMode.NONE;
        this._setLocked(lock);
    }

    showLater() {
        this.actor.show();

        if (Main.sessionMode.currentMode !== 'unlock-dialog') {
            this._isGreeter = Main.sessionMode.isGreeter;
            if (!this._isGreeter)
                Main.sessionMode.pushMode('unlock-dialog');
        }

        this._lockScreenGroup.show();

        this._lockScreenShown();
    }

    // If the previous shell crashed, and gnome-session restarted us, then re-lock
    lockIfWasLocked() {
        if (!this._settings.get_boolean(LOCK_ENABLED_KEY))
            return;
        let wasLocked = global.get_runtime_state('b', LOCKED_STATE_STR);
        if (wasLocked === null)
            return;
        const laters = global.compositor.get_laters();
        laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this.lock(false);
            return GLib.SOURCE_REMOVE;
        });
    }
}
