import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {loadInterfaceXML} from './misc/dbusUtils.js';
import * as Signals from './misc/signals.js';

const SensorProxyIface = loadInterfaceXML('net.hadess.SensorProxy');
const SensorProxyProxy = Gio.DBusProxy.makeProxyWrapper(SensorProxyIface);

const SensorTypes = {
    AMBIENT_LIGHT: 'ambient-light',
    PROXIMITY: 'proximity',
    COMPASS: 'compass',
    ACCELEROMETER: 'accelerometer',
}

export class SensorDaemon extends Signals.EventEmitter {
    constructor() {
        super();

        this._claimedSensors = new Map;
        for (const sensor of Object.values(SensorTypes))
            this._claimedSensors.set(sensor, 0);
        this._claimingSensors = new Map();

        this._watchId = Gio.bus_watch_name(Gio.BusType.SYSTEM,
            'net.hadess.SensorProxy', 0,
            this._onIioSensorProxyAppeared.bind(this),
            this._onIioSensorProxyVanished.bind(this));
    }

    _onIioSensorProxyAppeared() {
        if (this._proxy)
            return;

        this._proxy = new SensorProxyProxy(Gio.DBus.system,
            'net.hadess.SensorProxy',
            '/net/hadess/SensorProxy',
            (proxy, error) => {
                if (error) {
                    console.error(error.message);
                    return;
                }

log("SENSORDAEMON: Sensor proxy init");
                this._proxy.connect('g-properties-changed',
                    this._propertiesChanged.bind(this));

                this.emit('ambient-light-available-changed');
                this.emit('proximity-available-changed');
            });
    }

    _onIioSensorProxyVanished() {
log("SENSORDAEMON: Sensor proxy disappeared");
        this._proxy = null;

        this.emit('ambient-light-available-changed');
        this.emit('proximity-available-changed');
    }

    async _propertiesChanged(proxy, properties) {
        for (const prop in properties.deepUnpack()) {
            switch (prop) {
            case 'HasAmbientLight':
                this.emit('ambient-light-available-changed');
                break;
            case 'HasProximity':
                this.emit('proximity-available-changed');
                break;
            case 'LightLevel':
                this.emit('ambient-light-level', this._proxy.LightLevel);
                break;
            case 'ProximityNear':
                this.emit('proximity-near', this._proxy.ProximityNear);
                break;
            default:
                break;
            }
        }
    }

    _sensorAvailable(sensorType) {
        if (!this._proxy)
            return false;

        switch (sensorType) {
        case SensorTypes.AMBIENT_LIGHT:
            return this._proxy.HasAmbientLight;

        case SensorTypes.PROXIMITY:
            return this._proxy.HasProximity;
        }

        return false;
    }

    ambientLightAvailable() {
        return this._sensorAvailable(SensorTypes.AMBIENT_LIGHT);
    }

    proximityAvailable() {
        return this._sensorAvailable(SensorTypes.PROXIMITY);
    }

    async _claimSensor(sensorType) {
        if (!this._sensorAvailable(sensorType))
            throw new Error(`Sensor to claim (${sensorType}) not available`);

        try {
            let claimPromise = this._claimingSensors.get(sensorType);
            if (claimPromise) {
                // We're already trying to claim the sensor, wait for that existing
                // claim and block other clients too
                await claimPromise;
                this._claimedSensors.set(sensorType,
                    this._claimedSensors.get(sensorType) + 1)
                return;
            }

            switch (sensorType) {
            case SensorTypes.AMBIENT_LIGHT:
                claimPromise = this._proxy.ClaimLightAsync();
                break;
            case SensorTypes.PROXIMITY:
                claimPromise = this._proxy.ClaimProximityAsync();
                break;
            }

            this._claimingSensors.set(sensorType, claimPromise);
            await claimPromise;
            this._claimingSensors.delete(sensorType);

            this._claimedSensors.set(sensorType,
                this._claimedSensors.get(sensorType) + 1)
        } catch(e) {
            this._claimingSensors.delete(sensorType);
            console.error(`Claiming ${sensorType} sensor failed: ${e.message}`);
            throw e;
        }
    }

    async _releaseSensor(sensorType) {
        if (this._claimingSensors.has(sensorType))
            throw new Error(`Sensor to release (${sensorType}) is still being claimed`);

log("SENSORDAEMON release the sensor from claimed sensors");
        this._claimedSensors.set(sensorType,
            this._claimedSensors.get(sensorType) - 1)

        switch (sensorType) {
        case SensorTypes.AMBIENT_LIGHT:
            await this._proxy.ReleaseLightAsync();
            break;
        case SensorTypes.PROXIMITY:
            await this._proxy.ReleaseProximityAsync();
            break;
        }
    }

    async claimProximity() {
        if (this._claimedSensors.get(SensorTypes.PROXIMITY) === 0) {
            await this._claimSensor(SensorTypes.PROXIMITY);
        } else {
            this._claimedSensors.set(SensorTypes.PROXIMITY,
                this._claimedSensors.get(SensorTypes.PROXIMITY) + 1);
        }
    }

    async releaseProximity() {
        const claimed = this._claimedSensors.get(SensorTypes.PROXIMITY);
        if (claimed === 1)
            await this._releaseSensor(SensorTypes.PROXIMITY);
        else if (claimed > 1)
            this._claimedSensors.set(SensorTypes.PROXIMITY, claimed - 1);
        else
            throw new Error(`Invalid release of sensor ${SensorTypes.PROXIMITY}`);
    }

    get proximityNear() {
        return this._proxy.ProximityNear;
    }

    async claimAmbientLight() {
log("SENSORDAEMON: start claimAmbientLight()");
        if (this._claimedSensors.get(SensorTypes.AMBIENT_LIGHT) === 0) {
            await this._claimSensor(SensorTypes.AMBIENT_LIGHT);
        } else {
            this._claimedSensors.set(SensorTypes.AMBIENT_LIGHT,
                this._claimedSensors.get(SensorTypes.AMBIENT_LIGHT) + 1);
        }
    }

    async releaseAmbientLight() {
log("SENSORDAEMON releasing ambient");
        const claimed = this._claimedSensors.get(SensorTypes.AMBIENT_LIGHT);
        if (claimed === 1)
            await this._releaseSensor(SensorTypes.AMBIENT_LIGHT);
        else if (claimed > 1)
            this._claimedSensors.set(SensorTypes.AMBIENT_LIGHT, claimed - 1);
        else
            throw new Error(`Invalid release of sensor ${SensorTypes.AMBIENT_LIGHT}`);
    }

    get ambientLightLevel() {
        return this._proxy.LightLevel;
    }
}
