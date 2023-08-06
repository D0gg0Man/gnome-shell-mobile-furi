import AccountsService from 'gi://AccountsService';
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gdm from 'gi://Gdm';
import Gio from 'gi://Gio';
import GnomeDesktop from 'gi://GnomeDesktop';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from './background.js';
import * as Calendar from './calendar.js';
import * as Layout from './layout.js';
import * as Main from './main.js';
import * as MessageTray from './messageTray.js';
import * as SwipeTracker from './swipeTracker.js';
import {formatDateWithCFormatString} from '../misc/dateUtils.js';
import {wiggle} from '../misc/animationUtils.js';
import * as AuthPrompt from '../gdm/authPrompt.js';
import {AuthPromptStatus} from '../gdm/authPrompt.js';
import {MprisSource} from './mpris.js';
import {MediaMessage} from './messageList.js';

// The timeout before going back automatically to the lock screen (in seconds)
const IDLE_TIMEOUT = 2 * 60;

// The timeout before showing the unlock hint (in seconds)
const HINT_TIMEOUT = 4;

const CROSSFADE_TIME = 300;
const FADE_OUT_TRANSLATION = 500;
const FADE_OUT_SCALE = 0.3;

const BLUR_BRIGHTNESS = 0.65;
const BLUR_RADIUS = 90;

const Clock = GObject.registerClass(
class UnlockDialogClock extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'unlock-dialog-clock',
            orientation: Clutter.Orientation.VERTICAL,
        });

        this._time = new St.Label({
            style_class: 'unlock-dialog-clock-time',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._date = new St.Label({
            style_class: 'unlock-dialog-clock-date',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this.add_child(this._time);
        this.add_child(this._date);

        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._wallClock.connect('notify::clock', this._updateClock.bind(this));

        this._updateClock();

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _updateClock() {
        this._time.text = this._wallClock.clock.trim();

        let date = new Date();
        /* Translators: This is a time format for a date in
           long format */
        let dateFormat = Shell.util_translate_time_string(N_('%A %B %-d'));
        this._date.text = formatDateWithCFormatString(date, dateFormat);
    }

    _onDestroy() {
        this._wallClock.run_dispose();
    }
});

var UnlockDialogSwipeHint = GObject.registerClass(
class UnlockDialogSwipeHint extends St.Label {
    _init() {
        super._init({
            style_class: 'unlock-dialog-clock-hint',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: 255,//0,
        });

        const backend = this.get_context().get_backend();
        this._seat = backend.get_default_seat();
        this._seat.connectObject('notify::touch-mode',
            this._updateHint.bind(this), this);

//        this._monitorManager = global.backend.get_monitor_manager();
  //      this._monitorManager.connectObject('power-save-mode-changed',
    //        () => (this.opacity = 0), this);

        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._idleWatchId = this._idleMonitor.add_idle_watch(HINT_TIMEOUT * 1000, () => {
            this.ease({
                opacity: 255,
                duration: CROSSFADE_TIME,
            });
        });

        this._updateHint();

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _updateHint() {
        this.text = this._seat.touch_mode
            ? _('Swipe up to unlock')
            : _('Click or press a key to unlock');
    }

    _onDestroy() {
        this._idleMonitor.remove_watch(this._idleWatchId);
    }
});

const UnlockDialogLayout = GObject.registerClass(
class UnlockDialogLayout extends Clutter.LayoutManager {
    _init(clock, notifications) {
        super._init();

        this._clock = clock;
        this._notifications = notifications;
    }

    vfunc_get_preferred_width(container, forHeight) {
        return this._clock.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(container, forWidth) {
        return this._clock.get_preferred_height(forWidth);
    }

    vfunc_allocate(container, box) {
        let [availWidth, availHeight] = box.get_size();

        let tenthOfHeight = availHeight / 10.0;
        let thirdOfHeight = availHeight / 3.0;

        let [, , clockWidth, clockHeight] =
            this._clock.get_preferred_size();

      //  if (this._clock.needs_expand(Clutter.Orientation.HORIZONTAL))
        //    clockWidth = availWidth;
    //    if (this._clock.needs_expand(Clutter.Orientation.VERTICAL))
      //      clockHeight = availHeight;

        let [, , notificationsWidth, notificationsHeight] =
            this._notifications.get_preferred_size();

        let columnX1 = 0;
        let actorBox = new Clutter.ActorBox();

        // Notifications
        let maxNotificationsHeight = Math.min(
            notificationsHeight,
            availHeight - clockHeight);

        actorBox.x1 = columnX1;
        actorBox.y1 = availHeight - maxNotificationsHeight;
        actorBox.x2 = columnX1 + availWidth;
        actorBox.y2 = actorBox.y1 + maxNotificationsHeight;
        this._notifications.allocate(actorBox);

        // Authentication Box
        let clockY = Math.min(
            tenthOfHeight,
            availHeight - clockHeight - maxNotificationsHeight);

        actorBox.x1 = columnX1;
        actorBox.y1 = clockY;
        actorBox.x2 = columnX1 + availWidth;
        actorBox.y2 = clockY + clockHeight;

        this._clock.allocate(actorBox);
    }
});

export const UnlockDialog = GObject.registerClass({
    Signals: {
        'wake-up-screen': {},
        'show-emergency-calls': {},
    },
}, class UnlockDialog extends St.Widget {
    _init(parentActor) {
        super._init({
            accessible_role: Atk.Role.WINDOW,
            style_class: 'unlock-dialog',
            visible: false,
            reactive: true,
        });

        parentActor.add_child(this);

        this._gdmClient = new Gdm.Client();

        try {
            this._gdmClient.set_enabled_extensions([
                Gdm.UserVerifierChoiceList.interface_info().name,
            ]);
        } catch {
        }

        this._swipeTracker = new SwipeTracker.SwipeTracker(this,
            Clutter.Orientation.VERTICAL,
            Shell.ActionMode.UNLOCK_SCREEN,
            {
                name: 'UnlockDialog swipe tracker',
            });
        this._swipeTracker.connect('begin', this._swipeBegin.bind(this));
        this._swipeTracker.connect('update', this._swipeUpdate.bind(this));
        this._swipeTracker.connect('end', this._swipeEnd.bind(this));

        this.connect('scroll-event', (o, event) => {
            if (this._swipeTracker.canHandleScrollEvent(event))
                return Clutter.EVENT_PROPAGATE;

            let direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.UP)
                this._showClock();
            else if (direction === Clutter.ScrollDirection.DOWN)
                this._showPrompt();
            return Clutter.EVENT_STOP;
        });

        this._activePage = null;

        this._clickGesture = new Clutter.ClickGesture();
        this._clickGesture.connect('should-handle-sequence', (_gesture, event) => {
            return event.type() === Clutter.EventType.BUTTON_PRESS;
        });
        this._clickGesture.connect('recognize', () => this._showPrompt());
        this.add_action(this._clickGesture);

        // Background
        this._backgroundGroup = new Clutter.Actor();
        this.add_child(this._backgroundGroup);

        this._bgManagers = [];

        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        themeContext.connectObject('notify::scale-factor',
            () => this._updateBackgroundEffects(), this);

        this._updateBackgrounds();
        Main.layoutManager.connectObject('monitors-changed',
            this._updateBackgrounds.bind(this), this);

        this._userManager = AccountsService.UserManager.get_default();
        this._userName = GLib.get_user_name();
        this._user = this._userManager.get_user(this._userName);

        // Authentication & Clock stack
        this._stack = new Shell.Stack();
        this._stack.x_expand = true;
        this._stack.y_expand = true;

        this._clockNotificationsBox = new St.BoxLayout({
            style_class: 'clock-notifications-box',
            vertical: true,
        });
        this._clockNotificationsBox.set_pivot_point(0.5, 0.5);

        this._clock = new Clock();
        this._clock.x_expand = true;

        this._notificationsBox = new Calendar.CalendarMessageList({
            isOnLockscreen: true,
        });
        this._notificationsSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications',
        });
        Main.messageTray.connect('source-added', (tray, source) => {
            const policyChangedId = source.policy.connect('notify', () =>
                this._maybeWakeUpScreenForSource(source));

            source.connectObject(
                'notification-added', (source, notification) =>
                    this._maybeWakeUpScreenForSource(source),
                'destroy', () => source.policy.disconnect(policyChangedId),
                this);
        });

        this._swipeUpHint = new UnlockDialogSwipeHint();

        this._buttonRow = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'unlock-dialog-button-row',
        });
        const cameraButton = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            icon_name: 'screenshooter-symbolic',
            visible: !Main.sessionMode.isGreeter,
            accessible_name: _('Take Screenshot'),
        });
        let cameraApp = Shell.AppSystem.get_default().lookup_app('org.gnome.Snapshot.desktop');
        if (!cameraApp)
            cameraApp = Shell.AppSystem.get_default().lookup_app('org.gnome.Snapshot.Devel.desktop');
        if (!cameraApp)
            cameraButton.add_style_class_name('unavailable');
        cameraButton.connect('clicked', () => {
            if (cameraApp) {
                cameraApp.activate_full(-1, 0);
                this.emit('show-emergency-calls');
            }
        });
        this._buttonRow.add_child(cameraButton);

        this._clockNotificationsBox.add_child(this._clock);
        this._clockNotificationsBox.add_child(this._notificationsBox);
        this._clockNotificationsBox.add_child(this._swipeUpHint);
        this._clockNotificationsBox.add_child(this._buttonRow);
        this._stack.add_child(this._clockNotificationsBox);

        this._promptBox = new St.BoxLayout({
            style_class: 'prompt-box',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.END,
        });
        this._promptBox.set_pivot_point(0.5, 0.5);
        this._stack.add_child(this._promptBox);

        this._promptBox.connect('notify::size', () => {
            if (this._promptBoxHeight)
                return;
            this._promptBoxHeight = this._promptBox.allocation.get_height();
            this._promptBox.translation_y = this._promptBoxHeight;
        });

        this._ensureAuthPrompt();

        this._showClock();

    /*    this._clockNotificationsBox.layout_manager = new UnlockDialogLayout(
            this._clock,
            this._notificationsBox,
            this._swipeUpHint,
            this._buttonRow);
*/
        this.allowCancel = false;

        Main.ctrlAltTabManager.addGroup(this, _('Unlock Window'), 'dialog-password-symbolic');


        // Switch User button
        this._otherUserButton = new St.Button({
            style_class: 'login-dialog-button switch-user-button',
            accessible_name: _('Log in as another user'),
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            reactive: false,
            opacity: 0,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            icon_name: 'system-users-symbolic',
        });
        this._otherUserButton.set_pivot_point(0.5, 0.5);
        this._otherUserButton.connect('clicked', this._otherUserClicked.bind(this));

        this._screenSaverSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.screensaver'});

        this._screenSaverSettings.connectObject('changed::user-switch-enabled',
            this._updateUserSwitchVisibility.bind(this), this);

        this._lockdownSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.lockdown'});
        this._lockdownSettings.connect('changed::disable-user-switching',
            this._updateUserSwitchVisibility.bind(this));

        this._user.connectObject(
            'notify::is-loaded', () => this._updateUserSwitchVisibility(),
            'notify::has-multiple-users', () => this._updateUserSwitchVisibility(),
            this);

        this._updateUserSwitchVisibility();

        // Main Box
        let mainBox = new St.BoxLayout();
        mainBox.add_constraint(new Layout.MonitorConstraint({primary: true}));
        mainBox.add_child(this._stack);
        mainBox.add_child(this._otherUserButton);

        this.add_child(mainBox);

        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._idleWatchId = this._idleMonitor.add_idle_watch(IDLE_TIMEOUT * 1000, this._escape.bind(this));

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _maybeWakeUpScreenForSource(source) {
        if (!this._notificationsSettings.get_boolean('show-banners'))
            return;

        if (!source.policy.showInLockScreen)
            return;

log("UNLOCKDIALOG: waking up screen on notification");
        this.emit('wake-up-screen');
    }

    vfunc_key_press_event(event) {
        const focus = global.stage.key_focus;
        if (this._activePage === this._promptBox &&
            this._authPrompt && this._authPrompt.contains(focus))
            return Clutter.EVENT_PROPAGATE;

        const keyval = event.get_key_symbol();
        if (keyval === Clutter.KEY_Shift_L ||
            keyval === Clutter.KEY_Shift_R ||
            keyval === Clutter.KEY_Shift_Lock ||
            keyval === Clutter.KEY_Caps_Lock)
            return Clutter.EVENT_PROPAGATE;

        let unichar = event.get_key_unicode();

        this._showPrompt();

        if (GLib.unichar_isgraph(unichar))
            this._authPrompt.addCharacter(unichar);

        return Clutter.EVENT_PROPAGATE;
    }

    _createBackground(monitorIndex) {
        let monitor = Main.layoutManager.monitors[monitorIndex];
        let widget = new St.Widget({
            style_class: 'screen-shield-background',
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            effect: new Shell.BlurEffect({name: 'blur'}),
        });

        let bgManager = new Background.BackgroundManager({
            container: widget,
            monitorIndex,
            controlPosition: false,
        });

        this._bgManagers.push(bgManager);

        this._backgroundGroup.add_child(widget);
    }

    _updateBackgroundEffects() {
        const themeContext = St.ThemeContext.get_for_stage(global.stage);

        for (const widget of this._backgroundGroup) {
            const effect = widget.get_effect('blur');

            if (effect) {
                effect.set({
                    brightness: BLUR_BRIGHTNESS,
                    radius: BLUR_RADIUS * themeContext.scale_factor,
                });
            }
        }
    }

    _updateBackgrounds() {
        for (let i = 0; i < this._bgManagers.length; i++)
            this._bgManagers[i].destroy();

        this._bgManagers = [];
        this._backgroundGroup.destroy_all_children();

        for (let i = 0; i < Main.layoutManager.monitors.length; i++)
            this._createBackground(i);
        this._updateBackgroundEffects();
    }

    _ensureAuthPrompt() {
        if (!this._authPrompt) {
            const pinEntryIndicator = new AuthPrompt.PinEntryIndicator(6);
      //      pinEntryIndicator.y_expand = true;
            pinEntryIndicator.y_align = Clutter.ActorAlign.END;
            pinEntryIndicator.x_align = Clutter.ActorAlign.CENTER;
            this._pinEntryIndicator = pinEntryIndicator;

            this._pinUnlockKeyboard = new AuthPrompt.PinUnlockKeyboard();
            this._pinUnlockKeyboard.y_align = Clutter.ActorAlign.CENTER;
            this._pinUnlockKeyboard.x_align = Clutter.ActorAlign.CENTER;

            this._authPrompt = new AuthPrompt.AuthPrompt(this._gdmClient,
                AuthPrompt.AuthPromptMode.UNLOCK_ONLY);
           // this._authPrompt.connect('failed', this._fail.bind(this));
            this._authPrompt.connect('cancelled', this._fail.bind(this));
            this._authPrompt.connect('reset', this._onReset.bind(this));
            this._authPrompt.connect('failed', () => {
                wiggle(pinEntryIndicator);
                pinEntryIndicator.setActiveDigits(0);
            });

            this._pinUnlockKeyboard.connect('char', (k, char) => {
                if (this._authPrompt._spinner._isPlaying)
                    return;

                this._authPrompt.addCharacter(char);

                pinEntryIndicator.setActiveDigits(this._authPrompt._entry.clutter_text.buffer.get_length());

                if (this._authPrompt._entry.clutter_text.buffer.get_length() === 6) {
                    pinEntryIndicator.setIsLoading(true);
                    this._authPrompt._entry.clutter_text.activate();
                }
            });
            this._pinUnlockKeyboard.connect('delete-last', () => {
                 if (this._authPrompt._spinner._isPlaying)
                    return;

                this._authPrompt.deleteLastCharacter();

                pinEntryIndicator.setActiveDigits(this._authPrompt._entry.clutter_text.buffer.get_length());
            });
            this._pinUnlockKeyboard.connect('delete-all', () => {
                if (this._authPrompt._spinner._isPlaying)
                    return;

                this._authPrompt.clear();
                pinEntryIndicator.setActiveDigits(0);
            });
            this._pinUnlockKeyboard.connect('show-full-keyboard', () => {
                this._authPrompt.mayShowEntry = true;
            });

            this._pinUnlockKeyboard.connect('show-full-keyboard', () => {
                if (pinEntryIndicator.visible) {
                    this._authPrompt.mayShowEntry = true;
                    pinEntryIndicator.hide();
                  //  this._authPrompt.show();
                } else {
                    this._authPrompt.mayShowEntry = false;
                    pinEntryIndicator.show();
                   // this._authPrompt.hide();
                }
            });

            this._promptBox.add_child(pinEntryIndicator);
            this._promptBox.add_child(this._authPrompt);
            this._promptBox.add_child(this._pinUnlockKeyboard);

            this._emergencyButton = new St.Button({
                style_class: 'emergency-call-button',
                label: 'Emergency',
                x_align: Clutter.ActorAlign.CENTER,
            });
            const callsApp = Shell.AppSystem.get_default().lookup_app('org.gnome.Calls.desktop');
            if (!callsApp)
                this._emergencyButton.add_style_class_name('unavailable');
            this._emergencyButton.connect('clicked', () => {
                if (callsApp) {
                    callsApp.activate_full(-1, 0);
                    this.emit('show-emergency-calls');
                }
            });
            this._promptBox.add_child(this._emergencyButton);

            if (Main.layoutManager.isPhone) {
                this._pinUnlockKeyboard.show();
                this._emergencyButton.show();
                pinEntryIndicator.show();
                this._authPrompt.y_align = Clutter.ActorAlign.END;
                this._authPrompt.y_expand = false;
                this._authPrompt.user_info_visible = false;
                this._authPrompt.mayShowEntry = false;
            } else {
                this._authPrompt.y_align = Clutter.ActorAlign.CENTER;
                this._pinUnlockKeyboard.hide();
                this._emergencyButton.hide();
                pinEntryIndicator.hide();
            }
        }

        const {verificationStatus} = this._authPrompt;
        switch (verificationStatus) {
        case AuthPromptStatus.NOT_VERIFYING:
        case AuthPromptStatus.VERIFICATION_CANCELLED:
        case AuthPromptStatus.VERIFICATION_FAILED:
            this._authPrompt.reset();
            this._authPrompt.updateSensitivity(
                verificationStatus === AuthPromptStatus.NOT_VERIFYING);
        }
    }

    _maybeDestroyAuthPrompt() {
        let focus = global.stage.key_focus;
        if (focus === null ||
            (this._authPrompt && this._authPrompt.contains(focus)) ||
            (this._otherUserButton && focus === this._otherUserButton))
            this.grab_key_focus();

        if (this._authPrompt) {
            this._authPrompt.destroy();
            this._authPrompt = null;
        }

        if (this._pinUnlockKeyboard) {
            this._pinUnlockKeyboard.destroy();
            this._pinUnlockKeyboard = null;
        }

        if (this._pinEntryIndicator) {
            this._pinEntryIndicator.destroy();
            this._pinEntryIndicator = null;
        }

        if (this._emergencyButton) {
            this._emergencyButton.destroy();
            this._emergencyButton = null;
        }
    }

    _showClock() {
        if (this._activePage === this._clockNotificationsBox)
            return;

        this._activePage = this._clockNotificationsBox;

        this._clickGesture.enabled = true;
    }

    _showPrompt() {
        this._ensureAuthPrompt();

        if (this._activePage === this._promptBox)
            return;

        this._activePage = this._promptBox;

        this._clickGesture.enabled = false;
    }

    _fail() {
        this._showClock();
    }

    _onReset(authPrompt, beginRequest) {
        let userName;
        if (beginRequest === AuthPrompt.BeginRequestType.PROVIDE_USERNAME) {
            this._authPrompt.setUser(this._user);
            userName = this._userName;
        } else {
            userName = null;
        }

        this._authPrompt.begin({userName});
    }

    _escape() {
        if (this._authPrompt && this.allowCancel)
            this._authPrompt.cancel();
    }

    _swipeBegin(tracker, monitor) {
        if (monitor !== Main.layoutManager.primaryIndex)
            return;

        this._promptBox.remove_transition('translation-y');

        this._ensureAuthPrompt();

        const progress = 1 - (this._promptBox.translation_y / this._promptBoxHeight);
        tracker.confirmSwipe(this._promptBoxHeight,
            [0, 1], 
            progress,
            progress);
    }

    _swipeUpdate(tracker, progress) {
        this._promptBox.translation_y = (1 - progress) * this._promptBoxHeight;
    }

    _swipeEnd(tracker, duration, endProgress, endCb) {
        this._activePage = endProgress
            ? this._promptBox
            : this._clockNotificationsBox;

        this._clickGesture.enabled = this._activePage === this._clockNotificationsBox;

        this._promptBox.ease({
            translation_y: (1 - endProgress) * this._promptBoxHeight,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            duration,
            onStopped: () => {
       //         if (this._activePage === this._clockNotificationsBox)
         //           this._maybeDestroyAuthPrompt();

                endCb();
            },
        });
    }

    _otherUserClicked() {
        Gdm.goto_login_session_sync(null);

        this._authPrompt.cancel();
    }

    _onDestroy() {
        this.popModal();

        if (this._idleWatchId) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = 0;
        }

        if (this._gdmClient) {
            this._gdmClient = null;
            delete this._gdmClient;
        }
    }

    _updateUserSwitchVisibility() {
        this._otherUserButton.visible =
            !Main.layoutManager.is_phone &&
            this._userManager.can_switch() &&
            this._userManager.has_multiple_users &&
            this._screenSaverSettings.get_boolean('user-switch-enabled') &&
            !this._lockdownSettings.get_boolean('disable-user-switching');
    }

    cancel() {
        if (this._authPrompt)
            this._authPrompt.cancel();
    }

    finish(onComplete) {
        if (!this._authPrompt) {
            onComplete();
            return;
        }

        this._authPrompt.finish(onComplete);
    }

    vfunc_collect_event_actors(target, forEvent) {
        if (Main.layoutManager.keyboardBox.contains(target) ||
            !!target._extendedKeys || !!target.extendedKey) {
            return Main.uiGroup.get_event_actors(target);
        } else {
            return this.get_event_actors(target);
        }
    }

    open() {
        this.show();

        if (this._isModal)
            return true;

        const grab = Main.pushModal(Main.uiGroup,
            {actionMode: Shell.ActionMode.UNLOCK_SCREEN});
        if (grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(grab);
            return false;
        }

        this._grab = grab;
        this._isModal = true;

        return true;
    }

    activate() {
        this._showPrompt();
    }

    popModal() {
        if (this._isModal) {
            Main.popModal(this._grab);
            this._grab = null;
            this._isModal = false;
        }
    }
});
