import Gio from 'gi://Gio';

import {loadInterfaceXML} from './misc/dbusUtils.js';

const DisplayConfigIface = loadInterfaceXML('org.gnome.Mutter.DisplayConfig');
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigIface);

export const ProximityMonitoring = class {
    constructor(sensorDaemon) {
        this._sensorDaemon = sensorDaemon;

        this._enableCount = 0;
        this._claimedSensor = false;

        this._proximityAvailable = this._sensorDaemon.proximityAvailable();
        this._sensorDaemon.connect('proximity-available-changed', async () => {
            if (this._enableCount === 0)
                return;

            const available = this._sensorDaemon.proximityAvailable();
            if (available && !this._claimedSensor)
                await this._startMonitoring();
            else if (!available && this._claimedSensor)
                await this._stopMonitoring();
        });

        this._sensorDaemon.connect('proximity-near',
            this._proximityNearChanged.bind(this));

        this._displayConfigProxy = new DisplayConfigProxy(Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig');
    }

    _proximityNearChanged() {
        if (!this._claimedSensor)
            return;

        if (this._enableCount === 0)
            throw new Error('Proximity changed and enable count is 0, but sensor claimed');

        log("PROXIMITYMONITORING: near changed: " + this._sensorDaemon.proximityNear);

        if (!this._screenOff && this._sensorDaemon.proximityNear) {
            this._displayConfigProxy.PowerSaveMode = 3;
            this._screenOff = true;
        } else if (this._screenOff && !this._sensorDaemon.proximityNear) {
            this._displayConfigProxy.PowerSaveMode = 0;
            this._screenOff = false;
        }
    }

    async _startMonitoring() {
        if (this._claimedSensor)
            throw new Error('Tried to start proximity monitoring but sensor already claimed');

        try {
            await this._sensorDaemon.claimProximity();
        } catch(e) {
            console.error(`Claiming proximity for monitoring failed: ${e}`);
            return;
        }

        this._claimedSensor = true;

        if (this._sensorDaemon.proximityNear) {
            this._displayConfigProxy.PowerSaveMode = 3;
            this._screenOff = true;
        }
    }

    _stopMonitoring() {
        if (!this._claimedSensor)
            return;

        this._claimedSensor = false;
        this._sensorDaemon.releaseProximity();

        if (this._screenOff) {
            this._displayConfigProxy.PowerSaveMode = 0;
            this._screenOff = false;
        }
    }

    async startMonitoring() {
        this._enableCount++;
        if (this._enableCount === 1 && this._sensorDaemon.proximityAvailable())
            await this._startMonitoring();
    }

    stopMonitoring() {
        this._enableCount--;
        if (this._enableCount === 0)
            this._stopMonitoring();
    }
};
