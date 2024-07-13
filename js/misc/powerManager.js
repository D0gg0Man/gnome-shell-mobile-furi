// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import UPower from 'gi://UPowerGlib';

import * as GnomeSession from './gnomeSession.js';
import * as LoginManager from './loginManager.js';
import * as Lightbox from '../ui/lightbox.js';
import {loadInterfaceXML} from './fileUtils.js';
import * as Main from '../ui/main.js';

const SESSION_SCHEMA = 'org.gnome.desktop.session';

const SCREENSAVER_SCHEMA = 'org.gnome.desktop.screensaver';
const LOCK_ENABLED_KEY = 'lock-enabled';
const LOCK_DELAY_KEY = 'lock-delay';

const LOCKDOWN_SCHEMA = 'org.gnome.desktop.lockdown';
const DISABLE_LOCK_KEY = 'disable-lock-screen';

const POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';

const LOCKED_STATE_STR = 'screenShield.locked';

const GsdWacomIface = loadInterfaceXML('org.gnome.SettingsDaemon.Wacom');
const GsdWacomProxy = Gio.DBusProxy.makeProxyWrapper(GsdWacomIface);

const DisplayConfigIface = loadInterfaceXML('org.gnome.Mutter.DisplayConfig');
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigIface);

const UpowerInterface = loadInterfaceXML('org.freedesktop.UPower');
const UpowerProxy = Gio.DBusProxy.makeProxyWrapper(UpowerInterface);

const SystemdManagerIface = loadInterfaceXML('org.freedesktop.systemd1.Manager');
const SystemdManagerProxy = Gio.DBusProxy.makeProxyWrapper(SystemdManagerIface);

const HostnameIface = loadInterfaceXML('org.freedesktop.hostname1');
const HostnameProxy = Gio.DBusProxy.makeProxyWrapper(HostnameIface);

const SensorDaemonIface = loadInterfaceXML('org.gnome.Shell.SensorDaemon');
const SensorDaemonProxy = Gio.DBusProxy.makeProxyWrapper(SensorDaemonIface);

const DEFAULT_SCREEN_FADE_OUT_TIME_MS = 250;

Gio._promisify(Shell, 'util_start_systemd_unit');
Gio._promisify(Shell, 'util_stop_systemd_unit');

function asyncSleep(durationMs) {
    return new Promise((resolve, reject) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, durationMs, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

export class PowerManager {
    constructor() {
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._cursorTracker = global.backend.get_cursor_tracker();

        this._lightbox = new Lightbox.Lightbox(Main.uiGroup, {
            fadeFactor: 1,
        });

        this._screensaverSettings = new Gio.Settings({schema_id: SCREENSAVER_SCHEMA});

        this._loginManager = LoginManager.getLoginManager();
        this._loginManager.connect('prepare-for-sleep',
            (m, a) => this._prepareForSleep(a).catch(e => console.error(e)));

        this._displayConfigProxy = new DisplayConfigProxy(Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            (proxy, error) => {
                if (error)
                    console.error(error.message);
            });

        this._upowerProxy = new UpowerProxy(Gio.DBus.system,
            'org.freedesktop.UPower',
            '/org/freedesktop/UPower',
            (proxy, error) => {
                if (error) {
                    console.error(error.message);
                    return;
                }

                this._upowerProxy.connect('g-properties-changed', () => this._upowerPropertiesChanged());
                this._onExternalPower = !this._upowerProxy.OnBattery;
            });

        new SystemdManagerProxy(Gio.DBus.system,
            'org.freedesktop.systemd1',
            '/org/freedesktop/systemd1',
            (proxy, error) => {
                if (error) {
                    console.error(error.message);
                    return;
                }

                this._runningInsideVm = proxy.Virtualization !== "";
            });

        new HostnameProxy(Gio.DBus.system,
            'org.freedesktop.hostname1',
            '/org/freedesktop/hostname1',
            (proxy, error) => {
                if (error) {
                    console.error(error.message);
                    return;
                }

                this._shouldNotifyAboutSuspend =
                    proxy.Chassis !== 'tablet' && proxy.Chassis !== 'handset';
            });

        this._sensorDaemonProxy = new SensorDaemonProxy(Gio.DBus.session,
            'org.gnome.Shell.SensorDaemon',
            '/org/gnome/Shell/SensorDaemon',
            (proxy, error) => {
                if (error) {
                    console.error(error.message);
                    return;
                }

                // sensor daemon might wait for sensor readings during certain calls,
                // if those take too long, we don't want to block unlocking the screen
                // for 60s, so limit to 2s.
                proxy.set_default_timeout(2000);
            });

        this._session = new GnomeSession.SessionManager();
        this._session.connect('g-properties-changed', () => this._sessionIsActiveChanged());
        this._sessionIsActive = this._session.SessionIsActive;

        Main.screenShield.connect('wake-up-screen', async () => {
            if (this._isInAction !== 'idle-blank' && this._isInAction !== 'blank')
                return;

            if (await this._isInPocket())
                return;

            // action might have been cancelled during the await
            if (this._isInAction !== 'idle-blank' && this._isInAction !== 'blank')
                return;

            if (this._screenOnForNotificationTimeout) {
                GLib.source_remove(this._screenOnForNotificationTimeout);
                delete this._screenOnForNotificationTimeout;
            }

            this._screenOnForNotificationTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                10 * 1000, () => {
                    log("POWERMANAGER: turning screen off after notification");
                    this._turnOffScreen(DEFAULT_SCREEN_FADE_OUT_TIME_MS);

                    delete this._screenOnForNotificationTimeout;
                    return GLib.SOURCE_REMOVE;
                });

            log("POWERMANAGER: turning screen on for notification");
            this._turnOnScreen();
        });

        Main.screenShield.connect('active-changed', () => this._updateScreensaverIdleWatch());

        this._sessionSettings = new Gio.Settings({schema_id: SESSION_SCHEMA});
        this._sessionSettings.connect(`changed::idle-delay`, this._updateScreensaverIdleWatch.bind(this));

        this._powerSettings = new Gio.Settings({schema_id: POWER_SCHEMA});
        this._powerSettings.connect(`changed::idle-dim`, this._updateScreensaverIdleWatch.bind(this));
        this._powerSettings.connect(`changed::sleep-inactive-ac-type`, this._updatePowersaveIdleWatch.bind(this));
        this._powerSettings.connect(`changed::sleep-inactive-battery-type`, this._updatePowersaveIdleWatch.bind(this));
        this._powerSettings.connect(`changed::sleep-inactive-ac-timeout`, this._updatePowersaveIdleWatch.bind(this));
        this._powerSettings.connect(`changed::sleep-inactive-battery-timeout`, this._updatePowersaveIdleWatch.bind(this));

        this._updateScreensaverIdleWatch();
        this._updatePowersaveIdleWatch();

        const setupLoginSession = async () => {
            this._loginSession = await this._loginManager.getCurrentSessionProxy();
            this._loginSession.connect('g-properties-changed',
                () => {
                    log("POWERMANAGER: properties of login session changed");
                    this._syncInhibitor(true)
                });

            await this._syncInhibitor(true);

            this._powerKeyInhibitor = await this._loginManager.inhibit(
                'handle-power-key:handle-suspend-key:handle-hibernate-key',
                'block',
                _('GNOME Shell handling power keys'),
                null);
        };
        setupLoginSession();
    }

    _sessionIsActiveChanged() {
        const sessionWasActive = this._sessionIsActive;
        this._sessionIsActive = this._session.SessionIsActive;
        if (sessionWasActive === this._sessionIsActive)
            return;

        log("POWERMANAGER: session active changed: " + this._sessionIsActive);
        if (!this._sessionIsActive && this._isInAction)
            this._maybeCancelAction('session-inactive');
    }

    async _maybeCancelAction(cancelReason) {
        const ongoingAction = this._isInAction;
        if (!ongoingAction)
            throw new Error('_maybeCancelAction called without being in action');

        if (this._suspended) {
            // suspend can't be cancelled during actual suspend (so from prepare-for-sleep=true
            // until prepare-for-sleep=false)
            log(`POWERMANAGER: cancelling action '${ongoingAction}' with reason '${cancelReason}' disallowed while suspended`);
            return false;
        }

        // ugh, need to prevent reentry during the awaits below, if we allow for that
        // we'll be in really weird behavior. One case where this happens is when
        // kernel replays power button presses while we're in this._isInPocket() on
        // suspend-wakeup
        if (this._cancellingActionLock) {
            if (this._newActionQueued) {
                log(`POWERMANAGER: _maybeCancelAction called with reason '${cancelReason}' while cancelling existing action '${ongoingAction}', but new action was queued, so cancelling that`);
                delete this._newActionQueued;
                return true;
            }

            log(`POWERMANAGER: _maybeCancelAction called with reason '${cancelReason}' while cancelling existing action '${ongoingAction}'`);
            return false;
        }

        log(`POWERMANAGER: cancelling action '${ongoingAction}' with reason '${cancelReason}'`);

        this._cancellingActionLock = (async () => {
            switch (cancelReason) {
            case 'power-button-press':
            case 'session-inactive':
                break;
            case 'suspend-wakeup':
                if (ongoingAction !== 'suspend' && ongoingAction !== 'suspend-forced' && ongoingAction !== 'hibernate')
                    throw new Error(`Woke up with reason 'suspend-wakeup' but no ongoing suspend/suspend-forced/hibernate, but rather '${ongoingAction}'`);

                if (this._suspendAgainTimeout)
                    throw new Error('this._suspendAgainTimeout set and suspend-wakeup happened');

                if (await this._isInPocket()) {
                    // If we woke up from suspend while in a pocket, try to suspend
                    // again after 10s. If nothing happened (or we were always in pocket)
                    // during those 10 seconds, we silently move to the "blank" action.
                    // Unfortunately we can't detect whether the wakeup came from
                    // the power button here.
                    log('POWERMANAGER: woke up from suspend while in pocket, suspending again in 10 seconds without user activity');

                    if (!this._userActiveId) {
                        this._userActiveId = this._idleMonitor.add_user_active_watch(
                            () => this._onUserActive().catch(e => console.error(e)));
                    }

                    this._suspendAgainTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10 * 1000, () => {
                        this._isInPocket().then(inPocket => {
                            if (this._isInAction !== ongoingAction)
                                throw new Error(`Suspend again timeout finished, but action is no longer '${ongoingAction}', but rather '${this._isInAction}'`);

                            if (!inPocket) {
                                log('POWERMANAGER: 10 seconds have passed, were no longer in pocket, moving to blank action');
                                this._isInAction = 'blank';
                                return;
                            }

                            log('POWERMANAGER: no power press seen in 10 seconds and still in pocket, suspending again');

                            this._suspended = true;

                            this._loginManager.suspend().catch(e => {
                                log(`POWERMANAGER: failed to suspend again: ${e}`);
                                delete this._isInAction;
                                delete this._suspended;
                                this._turnOnScreen();
                            });
                        });

                        delete this._suspendAgainTimeout;
                        return GLib.SOURCE_REMOVE;
                    });

                    return false;
                }

                break;
            case 'user-active':
                if (ongoingAction !== 'dim' && (await this._isInPocket()))
                    return false;

                break;
            default:
                throw new Error(`Unknown cancel reason: ${cancelReason}`);
            }

            this._actionStartCancellable?.cancel();
            delete this._actionStartCancellable;
         //   delete this._enteringActionLock;
            delete this._isInAction;

            if (this._userAlreadyIdle) {
                if (!this._userActiveId)
                    throw new Error('there must still be a user active watch when deferring blank');

                const idleTimeoutMs = Main.screenShield.active
                    ? 10 * 1000
                    : this._sessionSettings.get_uint('idle-delay') * 1000;

                log("POWERMANAGER: starting timeout for deferred idle blank action after existing action was cancelled");
                this._deferredIdleBlankId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, idleTimeoutMs, () => {
                    log("POWERMANAGER: executing deferred idle blank action after existing action was cancelled");
                    this._doSystemAction('idle-blank', 'deferred idle blank until after action cancelling', true, Main.screenShield.active ? DEFAULT_SCREEN_FADE_OUT_TIME_MS : 10 * 1000).catch(e => console.error(e));
                    delete this._deferredIdleBlankId;
                    return GLib.SOURCE_REMOVE;
                });

                delete this._userAlreadyIdle;
            } else {
                if (this._userActiveId) {
                    this._idleMonitor.remove_watch(this._userActiveId);
                    delete this._userActiveId;
                }
            }

            switch (ongoingAction) {
            case 'dim':
                this._lightbox.lightOff(0).catch();
                this._sensorDaemonProxy.UndimBacklightAsync(0).catch(e =>
                    log("POWERMANAGER: Undim backlight failed: " + e));

                break;
            case 'idle-blank':
                if (this._screenOnForNotificationTimeout) {
                    GLib.source_remove(this._screenOnForNotificationTimeout);
                    delete this._screenOnForNotificationTimeout;
                }

                if (Main.screenShield.active && !Main.screenShield.locked)
                    Main.screenShield.deactivate(false);

                this._turnOnScreen();

                break;
            case 'blank':
                if (this._screenOnForNotificationTimeout) {
                    GLib.source_remove(this._screenOnForNotificationTimeout);
                    delete this._screenOnForNotificationTimeout;
                }

                this._turnOnScreen();
                break;
            case 'suspend':
            case 'suspend-forced':
                if (this._suspendAgainTimeout) {
                    log("POWERMANAGER: removing suspend again source on cancel");
                    GLib.source_remove(this._suspendAgainTimeout);
                    delete this._suspendAgainTimeout;
                }

                this._turnOnScreen();
                break;
            case 'hibernate':
                this._turnOnScreen();
                break;
            case 'shutdown':
            case 'logout':
                break;
            }

            return true;
        })().finally(() => {
            delete this._cancellingActionLock;
        });

        return this._cancellingActionLock;
    }

    async _syncInhibitor(shouldInhibit, sync) {
        const inhibit = !!this._loginSession && this._loginSession.Active && shouldInhibit;

        if (inhibit === this._inhibited)
            return;

        this._inhibited = inhibit;

        this._inhibitCancellable?.cancel();
        this._inhibitCancellable = new Gio.Cancellable();

        if (inhibit) {
            try {
                log("POWERMANAGER: creating new login inhibitor");
                if (sync) {
                    this._inhibitor = this._loginManager.inhibitSync(
                        'sleep',
                        'delay',
                        _('GNOME Shell needs to lock the screen'),
                        this._inhibitCancellable);
                } else {
                    this._inhibitor = await this._loginManager.inhibit(
                        'sleep',
                        'delay',
                        _('GNOME Shell needs to lock the screen'),
                        this._inhibitCancellable);
                }
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    log('Failed to inhibit suspend: %s'.format(e.message));
            }
        } else {
                log("POWERMANAGER: closing login inhibitor");
            this._inhibitor?.close(null);
            this._inhibitor = null;
        }
    }

    async _prepareForSleep(aboutToSuspend) {
        log("POWERMANAGER: prepareForSleep: suspending=" + aboutToSuspend + " this._suspended=" + this._suspended);

        if (aboutToSuspend) {
            if (this._suspendWarningNotification) {
                this._suspendWarningNotification.destroy();
                delete this._suspendWarningNotification;
            }

            if (this._suspendAgainTimeout) {
                GLib.source_remove(this._suspendAgainTimeout);
                delete this._suspendAgainTimeout;
            }

            if ((this._isInAction !== "suspend" && this._isInAction !== "hibernate") || this._cancellingActionLock) {
                // when suspending via "systemctl suspend", we don't go via our
                // power manager, still make sure screen get locked etc.
//                log("POWERMANAGER: not in suspend/hibernate action or currently cancelling, entering suspend implicitly");
                await this._doSystemAction("suspend-forced", 'unknown');
            } else {
                // also yayy even more async madness: we can enter a suspend while executing the
                // suspend action (eg. somebody called systemctl suspend while async waiting for screen to fade out). We really
                // want to avoid releasing our inhibitor and actually suspending in the middle
                // _doSystemAction(), _doSystemAction() will finish and call logind.suspend()
                // after the resume.
                if (!this._suspended)
                    await this._doSystemAction("suspend-forced", 'unknown');
            }

            if (this._isInAction !== "suspend" && this._isInAction !== "hibernate" && this._isInAction !== "suspend-forced") {
                // Usually suspends are not cancellable, so if somebody managed to cancel a
                // suspend at this point, it *must* have gone through _prepareForSleep(false).
                // This is guaranteed, because there's no other way to cancel a suspend action
                // while this._suspended is set (which we did implictly set above)
                log("POWERMANAGER: suspend was cancelled while in prepareForSleep, bailing out.");
                return;
            }

            if (!this._suspended)
                throw new Error(`POWERMANAGER: this._suspended is not set but we're in the correct action: ${this._isInAction}`);

            this._syncInhibitor(false, true);
        } else {
            this._ignoreInputAfterSuspend = true;
            this._ignoreInputAfterSuspendStartMs = GLib.get_monotonic_time() / 1000;
            delete this._suspended;

            // wanna add the inhibitor synchronously here as first thing to ensure that it still
            // happens within the ::prepare-for-sleep signal handler, and systemd
            // won't have a chance to suspend again without us having an inhibitor
            // installed.
            this._syncInhibitor(true, true);

            // Ignore power button input for 500 ms longer to avoid replayed events
            // that happend while we weren't suspended yet, but processes were already
            // frozen. g-s-d media-keys uses a 3 seconds timeout here.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                delete this._ignoreInputAfterSuspend;
                return GLib.SOURCE_REMOVE;
            });

            if (this._isInAction) {
                await this._maybeCancelAction('suspend-wakeup');
            } else {
                // no ongoing action, we were probably suspended via the kernel
                // directly. Still make sure the screen gets turned on...
                this._turnOnScreen();
            }
        }
    }

    async _onUserActive() {
//        log("POWERMANAGER: user became active, dpms mode " + this._displayConfigProxy.PowerSaveMode);

        // No need to disconnect from signal, this happens automatically when
        // user-active watches fire.
        delete this._userActiveId;

        if (this._deferredIdleBlankId) {
            GLib.source_remove(this._deferredIdleBlankId);
            delete this._deferredIdleBlankId;
            return;
        }

        if (!this._isInAction)
            throw new Error('user active watch fired but were not in an action');

        if (this._userAlreadyIdle)
            delete this._userAlreadyIdle;

        const wakeupEvent = Clutter.get_current_event();
        if (wakeupEvent &&
            wakeupEvent.type() === Clutter.EventType.KEY_PRESS &&
            wakeupEvent.get_key_symbol() === Clutter.KEY_PowerOff) {
//            log("POWERMANAGER: wakeup event is a power key press, will ignore the actual event");
            // handle power button presses in the actual event handler
            return;
        }

        if (!(await this._maybeCancelAction('user-active'))) {
            // yayy again for async, _maybeCancelAction might have finished a while
            // ago and we might have done other things in the mean time. So the action
            // might have gotten cancelled by someone else.
            if (!this._isInAction || this._cancellingActionLock)
                return;

            log("POWERMANAGER: failed to cancel action on user active, reinstalling watch");

            // action wasn't cancelled, reinstall user active watch
            if (!this._userActiveId) {
                this._userActiveId = this._idleMonitor.add_user_active_watch(
                    () => this._onUserActive().catch(e => console.error(e)));
            }
        }
    }

    async _turnOffScreen(fadeTime) {
        if (this._fadingOut)
            return;

        log("POWERMANAGER: _turnOffScreen(), _userActiveId: " + this._userActiveId);

        this._lightbox.remove_all_transitions();

        if (!(await this._fadeOut(fadeTime)))
            return;

        this._displayConfigProxy.PowerSaveMode = 3;

        if (!this._adaptiveBacklightInhibited) {
            try {
                await this._sensorDaemonProxy.InhibitAdaptiveBacklightAsync();
                this._adaptiveBacklightInhibited = true;
            } catch(e) {
                console.error("POWERMANAGER: inhibit adaptive backlight failed: " + e);
            }
        }
    }

    async _isInPocket() {
        try {
            const [proximityNear] = await this._sensorDaemonProxy.GetProximityOnceAsync();
            if (proximityNear)
                log("POWERMANAGER: pocket was detected, inhibiting power on for screen");

            return proximityNear;
        } catch(e) {
            console.error("POWERMANAGER: checking proximity failed: " + e);
            // no proximity sensor
            return false;
        }
    }

    async _turnOnScreen() {
        if (this._fadeInTimeout || this._fadingIn) {
log("POWERMANAGER: turn on this._fadeInTimeout " + this._fadeInTimeout + " this._fadingIn " + this._fadingIn);
            return;
}

        log("POWERMANAGER: _turnOnScreen()");

        this._lightbox.remove_all_transitions();

        if (this._adaptiveBacklightInhibited) {
            delete this._adaptiveBacklightInhibited;

            try {
                await this._sensorDaemonProxy.UninhibitAdaptiveBacklightAsync(true);
            } catch(e) {
                console.error("POWERMANAGER: uninhibit adaptive backlight failed: " + e);
                this._adaptiveBacklightInhibited = true;
            }
        }

        log("POWERMANAGER: _turnOnScreen(), dpms mode " + this._displayConfigProxy.PowerSaveMode + " opacity " + this._lightbox.opacity);

        // undim in case we were dimmed earlier and got woken up by something that's not a user active watch
        this._sensorDaemonProxy.UndimBacklightAsync(0).catch(e =>
            log("POWERMANAGER: Undim backlight failed: " + e));

        if (this._displayConfigProxy.PowerSaveMode === 3) {
            this._displayConfigProxy.PowerSaveMode = 0;
            // turning on the screen will take a while, make sure at least part of the
            // animation is shown by waiting a little...
  //          this._fadeInTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
//                delete this._fadeInTimeout;

                await this._fadeIn();
    //            return GLib.SOURCE_REMOVE;
      //      });
        } else {
            this._displayConfigProxy.PowerSaveMode = 0;
            await this._fadeIn();
        }
    }

    async _fadeOut(duration) {
        log("POWERMANAGER: _fadeOut()");

        if (this._fadeInTimeout) {
            GLib.source_remove(this._fadeInTimeout);
            delete this._fadeInTimeout;
        }

        this._fadingOut = true;

        this._cursorTracker.set_pointer_visible(false);
        Main.uiGroup.set_child_above_sibling(this._lightbox, null);
        this._lightbox._fadeFactor = 1;
        this._lightbox.reactive = true;

        try {
            await this._lightbox.lightOn(duration);
        } catch(e) {
            log("POWERMANAGER: _fadeOut() cancelled");
            delete this._fadingOut;
            return false;
        }

        delete this._fadingOut;
        return true;
    }

    async _fadeIn(callback) {
        if (this._fadeInTimeout || this._fadingIn) {
            log("POWERMANAGER: _fadeIn() already fading in");
            return;
        }

        log("POWERMANAGER: _fadeIn()");

        this._fadingIn = true;

        this._lightbox.reactive = false;

        try {
            await this._lightbox.lightOff(350);
        } catch(e) {
            log("POWERMANAGER: _fadeIn() cancelled");
        }

        delete this._fadingIn;
    }

    async _doSystemAction(action, debugReason, watchEarly, screenFadeTimeMs = DEFAULT_SCREEN_FADE_OUT_TIME_MS) {
        if (this._cancellingActionLock) {
            log(`POWERMANAGER: waiting for existing action to cancel before doing action '${action}' (reason '${debugReason}')`);
            this._newActionQueued = true;
            try { await this._cancellingActionLock } catch(e) {};
            if (!this._newActionQueued)
                return;

            delete this._newActionQueued;
        }

            // allow upgrading from dim to higher states 
        if ((this._isInAction === 'dim' &&
             (action === 'blank' || action === 'idle-blank' || action === 'suspend' || action === 'suspend-forced' || action === 'hibernate' || action === 'shutdown' || action === 'logout')) ||
            // allow upgrading from blank/idle-blank to higher states 
            ((this._isInAction === 'blank' || this._isInAction === 'idle-blank') &&
             (action === 'suspend' || action === 'suspend-forced' || action === 'hibernate' || action === 'shutdown' || action === 'logout')) ||
            // allow upgrading from suspend/hibernate to suspend-forced (see comment in _prepareForSleep) 
            ((this._isInAction === 'suspend' || this._isInAction === 'hibernate') &&
             (action === 'suspend-forced'))) {
            log(`POWERMANAGER: upgrading from '${this._isInAction}' action to '${action}'`);
            this._actionStartCancellable?.cancel();
            delete this._actionStartCancellable;
          //  delete this._enteringActionLock;
            delete this._isInAction;
        }

        if (this._isInAction) {
            log(`POWERMANAGER: not doing system action '${action}' (reason '${debugReason}') because there's already action '${this._isInAction}' ongoing`);
            return;
        }

        if (!this._sessionIsActive) {
            log(`POWERMANAGER: not doing system action '${action}' (reason '${debugReason}') because session is inactive`);
            return;
        } 

        if (this._actionStartCancellable)
            throw new Error('Called _doSystemAction() with this._actionStartCancellable set');

     //   if (this._enteringActionLock)
     //       throw new Error('Called _doSystemAction() with this._enteringActionLock set');

        if (this._suspended)
            throw new Error('Called _doSystemAction() with this._suspended set');

        if (action === 'nothing')
            return;

        log(`POWERMANAGER: doing system action '${action}' (reason '${debugReason}')`);

        if (watchEarly && !this._userActiveId) {
            this._userActiveId = this._idleMonitor.add_user_active_watch(
                () => this._onUserActive().catch(e => console.error(e)));
        }

        const cancellable = new Gio.Cancellable();
        this._actionStartCancellable = cancellable;
        this._isInAction = action;

        this._enteringActionLock = (async () => {
            switch (action) {
            case 'dim': {
                // ugh, we'll want a lightbox effect at the same time, because
                // at low brightness the dim is not really happening
                const wantLightboxEffect =
                    this._sensorDaemonProxy.BacklightBrightness < 0.3;

                this._sensorDaemonProxy.DimBacklightAsync(0.2, 500).catch(e =>
                    log("POWERMANAGER: Dim backlight failed: " + e));

                this._cursorTracker.set_pointer_visible(false);
                Main.uiGroup.set_child_above_sibling(this._lightbox, null);
                this._lightbox._fadeFactor = wantLightboxEffect ? 0.5 : 0;
                this._lightbox.reactive = true;
                this._lightbox.lightOn(500).catch(e => log("POWERMANAGER lightOn() cancelled"));

                break;
            }
            case 'idle-blank': {
                await this._turnOffScreen(screenFadeTimeMs);

                if (cancellable.is_cancelled())
                    return;

                // Artificially wait a bit longer for the monitor to actually turn off after
                // setting the PowerSaveMode. The actual DPMS power-off is async and we don't
                // know how long it'll take. DPMS includes turning off the touchscreen,
                // and therefore the touchscreen might not be disabled at this point. So
                // wait a bit longer to ensure that touch input events won't trigger the active
                // watch below and wake us up right again.
                await asyncSleep(350);

                if (cancellable.is_cancelled())
                    return;

                if (!watchEarly && !this._userActiveId) {
                    this._userActiveId = this._idleMonitor.add_user_active_watch(
                        () => this._onUserActive().catch(e => console.error(e)));
                }

                Main.screenShield.activate(false);

                if (cancellable.is_cancelled())
                    return;

                if (!this._screensaverSettings.get_boolean(LOCK_ENABLED_KEY))
                    return;

                // try to become modal now already, so that we fail before LOCK_DELAY
                // in case becoming modal fails
                if (!Main.screenShield._becomeModal()) {
                    Main.notifyError(
                        _('Unable to lock'),
                        _('Lock was blocked by an app'));
                    return;
                }

                const lockDelayMs = this._screensaverSettings.get_uint(LOCK_DELAY_KEY) * 1000;
                const lockTimeoutMs = Math.max(0, lockDelayMs - 10 * 1000);

                if (lockTimeoutMs > 0)
                    log("POWERMANAGER: waiting another " + lockTimeoutMs + "ms due to lock-delay");

                await asyncSleep(lockTimeoutMs);

                if (cancellable.is_cancelled())
                    return;

                Main.screenShield.lock(false);
                break;
            }
            case 'blank': {
                if (this._screensaverSettings.get_boolean(LOCK_ENABLED_KEY)) {
                    Main.screenShield.lock(false, true);
                    await this._turnOffScreen(screenFadeTimeMs).catch(e => console.error(e));
                    Main.screenShield.showLater();
                } else {
                    await this._turnOffScreen(screenFadeTimeMs);
                }

                if (cancellable.is_cancelled())
                    return;

                // Artificially wait a bit longer for the monitor to actually turn off after
                // setting the PowerSaveMode. The actual DPMS power-off is async and we don't
                // know how long it'll take. DPMS includes turning off the touchscreen,
                // and therefore the touchscreen might not be disabled at this point. So
                // wait a bit longer to ensure that touch input events won't trigger the active
                // watch below and wake us up right again.
                await asyncSleep(350);

                if (cancellable.is_cancelled())
                    return;

                if (!watchEarly && !this._userActiveId) {
                    this._userActiveId = this._idleMonitor.add_user_active_watch(
                        () => this._onUserActive().catch(e => console.error(e)));
                }

                break;
            }
            case 'suspend': {
                if (!(await this._loginManager.canSuspend()).canSuspend)
                    return;

                if (cancellable.is_cancelled())
                    return;

                if (this._screensaverSettings.get_boolean(LOCK_ENABLED_KEY)) {
                    Main.screenShield.lock(false, true);
                    await this._turnOffScreen(screenFadeTimeMs).catch(e => console.error(e));
                    Main.screenShield.showLater();
                } else {
                    await this._turnOffScreen(screenFadeTimeMs);
                }

                if (cancellable.is_cancelled())
                    return;

                if (!watchEarly && !this._userActiveId) {
                    this._userActiveId = this._idleMonitor.add_user_active_watch(
                        () => this._onUserActive().catch(e => console.error(e)));
                }

                // we'll now suspend via systemd, impossible to cancel after that.
                // The only way is getting a prepareForSleep(false) from systemd
                this._suspended = true;

                log("POWERMANAGER: suspending via logind now");

                try {
                    await this._loginManager.suspend();
                } catch (e) {
                    log(`POWERMANAGER: failed to suspend: ${e}`);
                    this._turnOnScreen();
                    delete this._isInAction;
                    delete this._suspended;
                }

                break;
            }
            case 'suspend-forced': {
                // impossible to cancel this. The only way is getting a prepareForSleep(false)
                // from systemd
                this._suspended = true;

                // Strictly speaking lock-enabled is defined as "lock the screen when
                // the screensaver goes active", but we interpret it as "lock the screen
                // when using screensaver, blanking, and suspending".
                if (this._screensaverSettings.get_boolean(LOCK_ENABLED_KEY) && !Main.screenShield.locked) {
                    Main.screenShield.lock(false);

                    // The suspend can happen quicker than we take to draw the next frame
                    // (ie. draw the lockscreen), and the display driver will restore the
                    // last drawn frame on resume. We must ensure the lockscreen is painted
                    // before the suspend so there's no single frame with the unlocked
                    // screen content visible after suspend. As long as we show some animation
                    // or wait otherwise before suspending, the next few lines are not
                    // necessary, but they are necessary when we skip animations and suspend
                    // immediately.
                    await new Promise((resolve, reject) => {
                        const id = global.stage.connect('after-update', () => {
                            log("POWERMANAGER: waited for stage update, now done");
                            global.stage.disconnect(id);
                            resolve();
                        });
                        global.stage.queue_redraw();
                    });

                    if (cancellable.is_cancelled())
                        return;
                }
    
                // systemd appears to already turn off the screen for us, we want
                // to call _turnOffScreen() anyway to ensure inhibit of auto-backlight
                // etc, but no need to fade out
                await this._turnOffScreen(0);

                if (cancellable.is_cancelled())
                    return;

                if (!watchEarly && !this._userActiveId) {
                    this._userActiveId = this._idleMonitor.add_user_active_watch(
                        () => this._onUserActive().catch(e => console.error(e)));
                }
                break;
            }
            case 'hibernate': {
                if (!(await this._loginManager.canHibernate()).canHibernate)
                    return;

                if (cancellable.is_cancelled())
                    return;

                if (this._screensaverSettings.get_boolean(LOCK_ENABLED_KEY)) {
                    Main.screenShield.lock(false, true);
                    await this._turnOffScreen(screenFadeTimeMs).catch(e => console.error(e));
                    Main.screenShield.showLater();
                } else {
                    await this._turnOffScreen(screenFadeTimeMs);
                }

                if (cancellable.is_cancelled())
                    return;

                if (!watchEarly && !this._userActiveId) {
                    this._userActiveId = this._idleMonitor.add_user_active_watch(
                        () => this._onUserActive().catch(e => console.error(e)));
                }

                // we'll now suspend via systemd, impossible to cancel after that.
                // The only way is getting a prepareForSleep(false) from systemd
                this._suspended = true;

                log("POWERMANAGER: hibernating via logind now");

                try {
                    await this._loginManager.hibernate();
                    log("POWERMANAGER: call to hibernate finished");
                } catch (e) {
                    log(`POWERMANAGER: failed to hibernate: ${e}`);
                    this._turnOnScreen();
                    delete this._isInAction;
                    delete this._suspended;
                }

                break;
            }
            case 'shutdown':
            case 'logout':
                log(`POWERMANAGER: ${action} is not supported at this point`);
                break;
            }
        })().finally(() => {
            delete this._actionStartCancellable;
            delete this._enteringActionLock;
        });

        return this._enteringActionLock;
    }

    _updateScreensaverIdleWatch() {
        log("POWERMANAGER: updating the screensaver idle watch, screenShield active " + Main.screenShield.active);
        if (this._dimIdleWatchId) {
            this._idleMonitor.remove_watch(this._dimIdleWatchId);
            delete this._dimIdleWatchId;
        }

        if (this._screensaverIdleWatchId) {
            this._idleMonitor.remove_watch(this._screensaverIdleWatchId);
            delete this._screensaverIdleWatchId;
        }

        const idleTimeoutMs = Main.screenShield.active
            ? 10 * 1000
            : this._sessionSettings.get_uint('idle-delay') * 1000;

        if (idleTimeoutMs === 0)
            return;

        const shouldDim =
            !Main.screenShield.active && this._powerSettings.get_boolean('idle-dim');

        if (shouldDim) {
            const dimIdleTimeMs = idleTimeoutMs / 2;
            this._dimIdleWatchId = this._idleMonitor.add_idle_watch(dimIdleTimeMs, () => {
                log("POWERMANAGER: dimming on idle");
                this._doSystemAction('dim', 'dim idle watch fired', true).catch(e => console.error(e));
            });
        }

        this._screensaverIdleWatchId = this._idleMonitor.add_idle_watch(idleTimeoutMs, () => {
        /*    if (this._isInAction) {
                log("POWERMANAGER: screensaver idle watch happened, deferring blank because we're already in action " + this._isInAction);
                // there should be only one way to system can be woken without the user becoming
                // active: a notification waking up the screen (which we handle by keeping the
                // blank action alive)
                // there is a second way though: bugs: wake up on user active takes so long (eg.
                // because dbus call to sensor daemon times out) that
                // we try to idle-blank in the mean time again. We won't blank though because we're
                // still inside an action, and then when we finally have cancelled the action,
                // system never blanks anymore.
                this._userAlreadyIdle = true;
                return;
            }*/

            log("POWERMANAGER: screensaver idle watch happened, blanking screen");
            this._doSystemAction('idle-blank', 'screensaver idle watch fired', true, Main.screenShield.active ? DEFAULT_SCREEN_FADE_OUT_TIME_MS : 10 * 1000).catch(e => console.error(e));
        });
    }

    _showInteractivePowerMenu() {
        Main.panel.statusArea.quickSettings.menu.box.translation_y = 0;
        Main.panel.statusArea.quickSettings.menu.open(true);
        Main.panel.statusArea.quickSettings._system._systemItem.get_children()[0].get_children()[6].menu.open()
    }

    _updatePowersaveIdleWatch() {
        const action = this._onExternalPower
            ? this._powerSettings.get_string('sleep-inactive-ac-type')
            : this._powerSettings.get_string('sleep-inactive-battery-type');
        const idleTimeoutMs = this._onExternalPower
            ? this._powerSettings.get_int('sleep-inactive-ac-timeout') * 1000
            : this._powerSettings.get_int('sleep-inactive-battery-timeout') * 1000;

        if (this._powersaveIdleWatchId) {
            this._idleMonitor.remove_watch(this._powersaveIdleWatchId);
            delete this._powersaveIdleWatchId;
        }

        if (this._powersaveMessageIdleWatchId) {
            this._idleMonitor.remove_watch(this._powersaveMessageIdleWatchId);
            delete this._powersaveMessageIdleWatchId;
        }

        log("POWERMANAGER: powersave idle watch setup, timeout " + idleTimeoutMs + "ms");

        if (this._runningInsideVm && (action === 'suspend' || action === 'hibernate'))
            return;

        if (Main.sessionMode.currentMode === 'gdm' && action === 'logout')
            return;

        if (action === 'suspend' || action === 'hibernate' || action === 'shutdown' ||
            action === 'logout') {
            const messageTimeoutMs = idleTimeoutMs - 60 * 1000;

            this._powersaveMessageIdleWatchId = this._idleMonitor.add_idle_watch(messageTimeoutMs, () => {
                if (!this._shouldNotifyAboutSuspend)
                     return;

                if (action === 'suspend')
                    this._suspendWarningNotification = Main.notify(_('Automatic suspend'), _('Suspending soon because of inactivity.'));
                else if (action === 'hibernate')
                    this._suspendWarningNotification = Main.notify(_('Automatic hibernation'), _('Suspending soon because of inactivity.'));
                else if (action === 'logout')
                    this._suspendWarningNotification = Main.notify(_('Automatic logout'), _('You will soon log out because of inactivity.'));

                this._idleMonitor.add_user_active_watch(() => {
                    if (this._suspendWarningNotification) {
                        this._suspendWarningNotification.destroy();
                        delete this._suspendWarningNotification;
                    }
                });
            });
        }

        this._powersaveIdleWatchId = this._idleMonitor.add_idle_watch(idleTimeoutMs, async () => {
            if (action === 'nothing')
                return;

            log(`POWERMANAGER: powersave idle watch happened, will execute action ${action}`);

            if (action === 'interactive') {
                this._showInteractivePowerMenu();
                return;
            }

            this._doSystemAction(action, 'powersave idle watch fired', true, 10 * 1000).catch(e => console.error(e));
        });
    }

    _upowerPropertiesChanged() {
        const wasOnExternalPower = this._onExternalPower;
        this._onExternalPower = !this._upowerProxy.OnBattery;

        if (this._onExternalPower === wasOnExternalPower)
            return;

        log("POWERMANAGER: on external power prop changed: " + this._onExternalPower);

        const player = global.display.get_sound_player();

        if (this._onExternalPower)
            player.play_from_theme('power-plug', _('On AC power'), null);
        else
            player.play_from_theme('power-unplug', _('On battery power'), null);

        this._updatePowersaveIdleWatch();
    }

    async powerButtonEvent(event) {
        const type = event.type();
        const screenIsOn = this._displayConfigProxy.PowerSaveMode === 0;

        const eventTimeMs = event.get_time();
        const timeNowMs = GLib.get_monotonic_time() / 1000;

        if (type === Clutter.EventType.KEY_RELEASE) {
            if (this._powerPressHappened) {
                delete this._powerPressHappened;

                if (!this._powerHoldId)
                    throw new Error('No this._powerHoldId set when releasing power key');

                GLib.source_remove(this._powerHoldId);
                delete this._powerHoldId;
            } else {
//log("POWERMANAGER: ignoring power key release because no press seen");
                return;
            }

            if (screenIsOn) {
                let action = this._powerSettings.get_string('power-button-action');
                if (action === 'nothing') { // FIXME: get rid of this in favor of new action
                    action = 'blank';
                } else if (action === 'interactive') {
                    this._showInteractivePowerMenu();
                    return;
                }

//log("POWERMANAGER: power key release (flags " + event.get_flags() + " " + (event.get_flags() & Clutter.EventFlags.FLAG_INPUT_METHOD) + "), executing action: " + action);

                this._doSystemAction(action, 'power key released', false).catch(e => console.error(e));
            }
        } else {
 //   log("POWERMANAGER: power key press, flags " +  event.get_flags() + " " + (event.get_flags() & Clutter.EventFlags.FLAG_INPUT_METHOD));

            if (this._ignoreInputAfterSuspend) {
                log("POWERMANAGER: ignoring power key press (event age " + (timeNowMs - eventTimeMs) + "ms) after suspend wakeup (" + (timeNowMs - this._ignoreInputAfterSuspendStartMs) + "ms after wakeup)");
                return;
            }

            if (this._isInAction) {
                await this._maybeCancelAction('power-button-press');
                // return here because we don't want to set this._powerPressHappened,
                // otherwise we'd do an action on the release of this press, and
                // we obviously don't want that.
                return;
            }


            this._powerPressHappened = true;
            this._powerHoldId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                this._showInteractivePowerMenu();

                delete this._powerPressHappened;
                delete this._powerHoldId;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    suspend() {
        this._doSystemAction('suspend', 'powerManager.suspend() called', false).catch(e => console.error(e));
    }

    blank() {
        this._doSystemAction('blank', 'powerManager.blank() called', false).catch(e => console.error(e));
    }
}
