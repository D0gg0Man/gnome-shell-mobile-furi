import Gio from 'gi://Gio';

import {loadInterfaceXML} from './misc/dbusUtils.js';

const DisplayConfigIface = loadInterfaceXML('org.gnome.Mutter.DisplayConfig');
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigIface);

export const ProximityMonitoring = class {
    constructor(sensorDaemon) {
        this._sensorDaemon = sensorDaemon;

        this._enableCount = 0;

        this._sensorDaemon.connect('proximity-near',
            this._proximityNearChanged.bind(this));

        this._displayConfigProxy = new DisplayConfigProxy(Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig');
    }

    _proximityNearChanged(sensorDaemon, isNear) {
        if (this._enableCount === 0)
            return;

        log("PROXIMITYMONITORING: near changed: " + isNear);

        if (!this._screenOff && isNear) {
            this._displayConfigProxy.PowerSaveMode = 3;
            this._screenOff = true;
        } else if (this._screenOff && !isNear) {
            this._displayConfigProxy.PowerSaveMode = 0;
            this._screenOff = false;
        }
    }

    async enableMonitoring() {
        this._enableCount++;

        if (this._enableCount === 1) {
            const claimed = await this._sensorDaemon.claimProximity();

            if (claimed && this._sensorDaemon.proximityNear) {
                this._displayConfigProxy.PowerSaveMode = 3;
                this._screenOff = true;
            }
        }
    }

    stopMonitoring() {
        this._enableCount--;

        if (this._enableCount === 0) {
            this._sensorDaemon.releaseProximity();

            if (this._screenOff) {
                this._displayConfigProxy.PowerSaveMode = 0;
                this._screenOff = false;
            }
        }
    }
};
