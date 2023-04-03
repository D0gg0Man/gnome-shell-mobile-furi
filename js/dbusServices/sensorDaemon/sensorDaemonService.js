import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ServiceImplementation} from './dbusService.js';

import {loadInterfaceXML} from './misc/dbusUtils.js';
import * as Signals from './misc/signals.js';

const SensorDaemonIface = loadInterfaceXML('org.gnome.Shell.SensorDaemon');

export const SensorDaemonService = class extends ServiceImplementation {
    constructor(sensorDaemon, proximityMonitoring) {
        super(SensorDaemonIface, '/org/gnome/Shell/SensorDaemon');

        this._autoShutdown = false;

        this._sensorDaemon = sensorDaemon;
        this._proximityMonitoring = proximityMonitoring;
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
}
