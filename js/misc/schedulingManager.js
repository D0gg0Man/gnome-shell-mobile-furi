// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Shell from 'gi://Shell';
import Gio from 'gi://Gio';

const UclampMinValues = {
    ON_IDLE: -1,
    // The value of 900 is observed to yield good animation smoothness with
    // Postmarket OS on OnePlus 6. In the future, we might have to compute
    // these values dynamically based on the characteristics of the SoC.
    FOCUS_WINDOW: 900,
    SHELL: 900,
}

// Time to wait before removing the clamp
const IDLE_TIME = 60000;

/**
 * Utilization clamping hints the Linux scheduler about the workload of a
 * given process. Some ARM CPUs have a big.LITTLE architecture to balance
 * between CPU performance and power efficiency.
 * 
 * The scheduling manager uses minimal utilization clamping to hint the
 * scheduler that a given process should be scheduled on the performant cores
 * instead of the efficient ones. This improves UI smoothness.
 * 
 * The hinting is only active for the focused application and for the shell
 * process when the user is not idle.
 */
export class SchedulingManager {
    constructor() {
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._idleMonitor.add_idle_watch(IDLE_TIME, this._onIdleMonitorBecameIdle.bind(this));

        this._shellPid = new Gio.Credentials().get_unix_pid();

        this._focusedWindowPid = null;

        global.display.connect('notify::focus-window', this._onWindowFocus.bind(this));
    }

    _onIdleMonitorBecameActive() {
        this._setMinimalClampForPid(this._shellPid, UclampMinValues.SHELL);

        if (this._focusedWindowPid)
            this._setMinimalClampForPid(this._focusedWindowPid, UclampMinValues.FOCUS_WINDOW);
    }

    _onIdleMonitorBecameIdle() {
        this._idleMonitor.add_user_active_watch(this._onIdleMonitorBecameActive.bind(this));

        this._setMinimalClampForPid(this._shellPid, UclampMinValues.ON_IDLE);
        if (this._focusedWindowPid)
            this._setMinimalClampForPid(this._focusedWindowPid, UclampMinValues.ON_IDLE);
    }

    _onWindowFocus() {
        // Unset the clamp on the old focused window
        if (this._focusedWindowPid)
            this._setMinimalClampForPid(this._focusedWindowPid, UclampMinValues.ON_IDLE);

        this._focusedWindowPid = global.display.focus_window?.get_pid();

        // Set the clamp on the newly focused window
        if (this._focusedWindowPid)
            this._setMinimalClampForPid(this._focusedWindowPid, UclampMinValues.FOCUS_WINDOW);

    };

    _setMinimalClampForPid(pid, clamp_value) {
        try {
            Shell.sched_set_minimal_utilization_clamping(pid, clamp_value);
        } catch (e) {
            log(`Couldn't set min utilization clamping for PID ${pid}: ${e.message}`);
        }
    }
}
