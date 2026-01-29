import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ServiceImplementation} from './dbusService.js';

import {loadInterfaceXML} from './misc/dbusUtils.js';
import * as Signals from './misc/signals.js';

const SensorDaemonIface = loadInterfaceXML('org.gnome.Shell.SensorDaemon');

export const SensorDaemonService = class extends ServiceImplementation {
    constructor(sensorDaemon, proximityMonitoring, autoBacklightBrightness) {
        super(SensorDaemonIface, '/org/gnome/Shell/SensorDaemon');

        this._autoShutdown = false;

        this._sensorDaemon = sensorDaemon;
        this._proximityMonitoring = proximityMonitoring;
        this._autoBacklightBrightness = autoBacklightBrightness;

        this._autoBacklightBrightness.connect('perceived-brightness-changed', () => {
            this._dbusImpl.emit_property_changed('BacklightBrightness',
                new GLib.Variant('d', this._autoBacklightBrightness.getPerceivedBrightnessPercent()));
        });
    }

    async StartProximityMonitoringAsync(params, invocation) {
        try {
            await this._proximityMonitoring.startMonitoring();
            invocation.return_value(null);
        } catch (error) {
            this._handleError(invocation, error);
        }
    }

    async StopProximityMonitoringAsync(params, invocation) {
        try {
            await this._proximityMonitoring.stopMonitoring();
            invocation.return_value(null);
        } catch (error) {
            this._handleError(invocation, error);
        }
    }

    async GetProximityOnceAsync(params, invocation) {
        try {
            if (!this._sensorDaemon.proximityAvailable()) {
                invocation.return_value(GLib.Variant.new('(b)', [false]));
                return;
            }

            await this._sensorDaemon.claimProximity();
            const proximityNear = this._sensorDaemon.proximityNear;
            await this._sensorDaemon.releaseProximity()

            log("SENSORDAEMON: GetProximityOnceAsync near: " + proximityNear);

            invocation.return_value(GLib.Variant.new('(b)', [proximityNear]));
        } catch (error) {
            this._handleError(invocation, error);
        }
    }

    async InhibitAdaptiveBacklightAsync(params, invocation) {
        try {
            await this._autoBacklightBrightness.inhibit();
            invocation.return_value(null);
        } catch (error) {
            this._handleError(invocation, error);
        }
    }

    async UninhibitAdaptiveBacklightAsync(params, invocation) {
        try {
            await this._autoBacklightBrightness.uninhibit(params[0]);
            invocation.return_value(null);
        } catch (error) {
            this._handleError(invocation, error);
        }
    }

    async DimBacklightAsync(params, invocation) {
        try {
            await this._autoBacklightBrightness.dim(params[0], params[1]);
            invocation.return_value(null);
        } catch (error) {
            this._handleError(invocation, error);
        }
    }

    async UndimBacklightAsync(params, invocation) {
        try {
            await this._autoBacklightBrightness.undim(params[0]);
            invocation.return_value(null);
        } catch (error) {
            this._handleError(invocation, error);
        }
    }

    async SetBacklightManuallyAsync(params, invocation) {
        try {
            await this._autoBacklightBrightness.setManually(params[0]);
            invocation.return_value(null);
        } catch (error) {
            this._handleError(invocation, error);
        }
    }

    get BacklightBrightness() {
        return this._autoBacklightBrightness.getPerceivedBrightnessPercent();
    }
}
