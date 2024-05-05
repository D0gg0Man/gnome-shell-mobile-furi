import AccountsService from 'gi://AccountsService';
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
        this.actor.add_child(this._lockDialogGroup);

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

        global.stage.connect('captured-event::key', (a, e) => {
            return this.maybeHandleEvent(e);
        });
    }

    maybeHandleEvent(e) {
        if (e.get_flags() !== Clutter.EventFlags.NONE)
            return Clutter.EVENT_PROPAGATE;

        const type = e.type();
        if (type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE)
            return Clutter.EVENT_PROPAGATE;

        if (e.get_key_symbol() !== Clutter.KEY_PowerOff)
            return Clutter.EVENT_PROPAGATE;

        Main.powerManager.powerButtonEvent(e);

        return Clutter.EVENT_STOP;
    }

    async _getLoginSession() {
        this._loginSession = await this._loginManager.getCurrentSessionProxy();
        this._loginSession.connectSignal('Lock',
            () => this.lock(false));
        this._loginSession.connectSignal('Unlock',
            () => this.deactivate(false));
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
        this._lockDialogGroup.translation_y = 0;
        this._lockScreenState = MessageTray.State.SHOWN;

        this._dialog.grab_key_focus();

        this._setActive(true);
    }

    _wakeUpScreen() {
        if (!this.active)
            return; // already woken up, or not yet asleep

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

            this._lockDialogGroup.ease({
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

        this._lockDialogGroup.ease({
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

            this._lockDialogGroup.translation_y = -global.screen_height;
            this._lockDialogGroup.remove_all_transitions();

            if (animate) {
                this._lockDialogGroup.ease({
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
