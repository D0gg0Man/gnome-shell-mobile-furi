import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GUdev from 'gi://GUdev';

import Akima from './akima.js';

import * as Signals from './misc/signals.js';
import {loadInterfaceXML} from './misc/dbusUtils.js';

const BrightnessInterface = loadInterfaceXML('org.freedesktop.login1.Session');
const BrightnessProxy = Gio.DBusProxy.makeProxyWrapper(BrightnessInterface);

const DEVICE_BRIGHTNESS_CONFIG = {
    // Pine64 Pinephone Pro
    'pine64,pinephone-pro': {
        brightnessToNitsCurve: [
            // logarithmic curve
            1, 20,
            3, 23,
            5, 27,
            10, 35,
            15, 50,
            25, 116,
            35, 233,
            45, 401,
            51, 550,
        ],
        ambientLuxToNits: [
            0, 20,
            1, 20,
            2, 20,
            4, 20,
            11, 27,
            25, 40,
            55, 76,
            90, 103,
            150, 130,
            200, 160,
            750, 250,
            1000, 300,
            2400, 450,
            4400, 550,
            // set higher values than what display supports, relative perceived brightness profits from that
            20000, 5000,
        ],
    },
    // OnePlus 6
    // values from enchilada android config (https://github.com/LineageOS/android_device_oneplus_enchilada/blob/lineage-20/overlay/frameworks/base/core/res/res/values/config.xml)
    'oneplus,enchilada': {
        brightnessToNitsCurve: [
            // our pwm values don't go from 0 to 255, but from 1 to 1023
            // so Android values were mapped to that
            // not correct on linux, we're actually pitch black at 0
            1, 2.0482,
            5, 2.7841,
            9, 3.79505,
            13, 4.4748,
            17, 5.08,
            21, 6.4233,
            25, 8.0848,
            29, 11.6607,
            33, 13.2347,
            37, 15.0676,
            41, 16.8302,
            45, 18.4261,
            49, 20.3103,
            53, 21.9042,
            57, 23.5456,
            61, 25.2137,
            65, 27.1769,
            69, 28.9571,
            73, 30.5244,
            77, 32.3535,
            81, 34.0867,
            101, 42.366,
            121, 51.1309,
            141, 59.52,
            161, 67.744,
            181, 75.9738,
            201, 84.6332,
            221, 94.1525,
            241, 102.2207,
            262, 110.4878,
            282, 117.0405,
            302, 124.3733,
            322, 130.9928,
            342, 140.4247,
            362, 149.3156,
            382, 157.1995,
            402, 165.3651,
            422, 173.2726,
            442, 181.4272,
            462, 189.1402,
            482, 197.5334,
            502, 205.6301,
            522, 213.9381,
            542, 222.2769,
            562, 230.0891,
            582, 238.6084,
            602, 246.5399,
            622, 255.6544,
            642, 263.6221,
            662, 271.9324,
            682, 279.1449,
            698, 288.5736,
            718, 297.6628,
            738, 306.1899,
            758, 314.4511,
            779, 322.1404,
            799, 330.969,
            819, 338.2251,
            839, 346.2251,
            859, 354.567,
            879, 370.799,
            899, 413.1738,
            919, 415.6397,
            939, 417.264,
            959, 419.264,
            979, 421.264,
            999, 424.646,
            1023, 427.6287,
        ],
        ambientLuxToNits: [
            0, 3.5077,
            1, 6.8394,
            4, 15.2619,
            12, 30.2619,
            20, 40.671,
            40, 52.3019,
            65, 65.2512,
            95, 77.37,
            140, 90.152,
            200, 100.297,
            350, 110.385,
            650, 135.064,
            1300, 160.5179,
            2000, 195.0267,
            3300, 380.2814,
            6000, 409.2867,
            10000, 427.6287,
            // set higher values than what display supports, relative perceived brightness profits from that
            20000, 5000,
        ],
    },
    // Microsoft Surface Pro 2017
    'Microsoft Corporation,Surface Pro,Surface_Pro_1796': {
        minMaxNits: [ 4, 440 ],
        minBrightness: 1,
        brightnessScale: 'linear',
        minSmoothTransitionBrightness: 2500,
        ambientLuxToNits: [
            // akima is a bit weird: for those sharp drops like "maintain 4 nits below 0.2 lux" it needs
            // 3 values that map to 1, not just 2 (with only 2 there will a "valley" between the two
            // 0.1 - 0.2 is measured in complete darkness
            0, 4, 
            0.1, 4,
            0.2, 4,
            2, 15,
            11, 27,
            25, 40,
            55, 70,
            90, 91,
            150, 120,
            200, 148,
            750, 196,
            1000, 280,
            2400, 490,
            // set higher values than what display supports, relative perceived brightness profits from that
            20000, 5000,
        ],
    },
    'default': {
        minMaxNits: [ 10, 400 ],
        minBrightness: 1,
        brightnessScale: 'linear',
        minSmoothTransitionBrightness: 0,
        ambientLuxToNits: [
            0, 10,
            1, 13,
            4, 18,
            11, 27,
            25, 40,
            55, 76,
            90, 103,
            150, 130,
            200, 160,
            750, 250,
            1000, 300,
            2000, 400,
            // set higher values than what display supports, relative perceived brightness profits from that
            20000, 5000,
        ],
    },
};

function linearMap(value, lowIn, highIn, lowOut, highOut) {
    return lowOut + (highOut - lowOut) * (value - lowIn) / (highIn - lowIn);
}

function round(number, precision) {
    const factor = 10 ** precision;
    return Math.round(number * factor) / factor;
}

export class AutoBacklightBrightness extends Signals.EventEmitter {
    constructor(sensorDaemon) {
        super();

        this._sensorDaemon = sensorDaemon;

        this._brightnessProxy = new BrightnessProxy(Gio.DBus.system ,
            'org.freedesktop.login1',
            '/org/freedesktop/login1/session/auto');

        this._udevClient = new GUdev.Client({subsystems: ['backlight']});
        const udevDevice = this._findUdevBacklightDevice();
        if (!udevDevice)
            throw new Error('No udev backlight device found, giving up');

        const backlightSysfsPath = udevDevice.get_sysfs_path();
        const brightnessFilePath = GLib.build_filenamev([backlightSysfsPath, 'brightness']);
        this._backlightSysfsFile = Gio.File.new_for_path(brightnessFilePath);
        this._backlightName = udevDevice.get_name();

        this._maxPwm = udevDevice.get_sysfs_attr_as_int('max_brightness');

        this._loadCalibrationForDevice();

        this._inhibitedCount = 0;
        this._dimFactor = 1.0;
        this._userDeltaPerceived = 0;
        this._enabled = false;
        this._history = [];

        this._settings = new Gio.Settings({
            schema_id: 'org.gnome.settings-daemon.plugins.power',
        });

        this._updateCurBrightnessFromUdev();
        this._curPerceived = this._targetPerceived = this._targetPerceivedNoOverrides = this._nitsToAbsPerceived(
              this._pwmToNits(this._curPwm));

        this._udevClient.connect('uevent', (_client, action, device) => {
            if (action === 'change' &&
                device.get_sysfs_path() === backlightSysfsPath)
                this._updateCurBrightnessFromUdev();
        });

        this._sensorDaemon.connect('ambient-light-level',
            this._ambientLightLevelChanged.bind(this));

        this._sensorDaemon.connect('ambient-light-available-changed', () =>
            this._syncEnabled().catch(e => log(e)));

        this._settings.connect('changed::ambient-enabled', () =>
            this._syncEnabled().catch(e => log(e)));

        this._syncEnabled().catch(e => log(e));
    }

    _getDeviceInfo() {
        const decoder = new TextDecoder();
        try {
            const compatiblePath = Gio.File.new_for_path('/sys/firmware/devicetree/base/compatible');
            // it's a NUL terminated string, so we split at 0-character
            const compatible = decoder.decode(compatiblePath.load_contents(null)[1]).split("\0")[0];
            if (compatible in DEVICE_BRIGHTNESS_CONFIG) {
                log(`AUTOBACKLIGHT: found device config from compatible file: ${compatible}`);
                return DEVICE_BRIGHTNESS_CONFIG[compatible];
            }
        } catch(e) {}

        try {
            const dmiVendorPath = Gio.File.new_for_path('/sys/class/dmi/id/sys_vendor');
            const dmiProductNamePath = Gio.File.new_for_path('/sys/class/dmi/id/product_name');
            const dmiVendor = decoder.decode(dmiVendorPath.load_contents(null)[1]).trim();
            const dmiProductName = decoder.decode(dmiProductNamePath.load_contents(null)[1]).trim();
            let key = dmiVendor + ',' + dmiProductName;
            if (key in DEVICE_BRIGHTNESS_CONFIG) {
                log(`AUTOBACKLIGHT: found device config from dmi file: ${key}`);
                return DEVICE_BRIGHTNESS_CONFIG[key];
            }

            const dmiSkuPath = Gio.File.new_for_path('/sys/class/dmi/id/product_sku');
            const dmiSku = decoder.decode(dmiSkuPath.load_contents(null)[1]).trim();
            key = dmiVendor + ',' + dmiProductName + ',' + dmiSku;
            if (key in DEVICE_BRIGHTNESS_CONFIG) {
                log(`AUTOBACKLIGHT: found device config from dmi file: ${key}`);
                return DEVICE_BRIGHTNESS_CONFIG[key];
            }
        } catch(e) {}

        log('AUTOBACKLIGHT: using default device config');
        return DEVICE_BRIGHTNESS_CONFIG['default'];
    }

    _loadCalibrationForDevice() {
        const deviceInfo = this._getDeviceInfo();

        if (deviceInfo.minMaxNits && deviceInfo.minBrightness && deviceInfo.brightnessScale)
            this._makeNitsToPwmCurve(deviceInfo.minMaxNits, deviceInfo.minBrightness, deviceInfo.brightnessScale);
        else if (deviceInfo.brightnessToNitsCurve)
            this._makeNitsToPwmCustomCurve(deviceInfo.brightnessToNitsCurve);
        else
            throw new Error('No mapping info for brightness->nits found');

        if (deviceInfo.ambientLuxToNits)
            this._makeLuxToNitsCurve(deviceInfo.ambientLuxToNits);
        else
            throw new Error('No mapping info for lux->nits found');

        if (deviceInfo.minSmoothTransitionBrightness === 0) {
            this._smoothTransitionThreshPerceived = this._maxPerceived;
        } else if (deviceInfo.minSmoothTransitionBrightness) {
            this._smoothTransitionThreshPerceived = this._nitsToAbsPerceived(
                this._pwmToNits(deviceInfo.minSmoothTransitionBrightness));
        } else {
            // If no smooth transition threshold is given, assume all transitions
            // are smooth.
            this._smoothTransitionThreshPerceived = this._minPerceived;
        }
    }

    _findUdevBacklightDevice() {
        const devices = this._udevClient.query_by_subsystem('backlight');

        // Search the backlight devices and prefer the types:
        // firmware -> platform -> raw
        for (const device of devices) {
            if (device.get_sysfs_attr('type') === 'firmware')
                return device;
        }

        for (const device of devices) {
            if (device.get_sysfs_attr('type') === 'platform')
                return device;
        }

        // Search for a raw backlight interface, raw backlight interfaces registered
        // by the drm driver will have the drm-connector as their parent, check the
        // drm-connector's enabled sysfs attribute so that we pick the right LCD-panel
        // connector on laptops with hybrid-gfx. Fall back to just picking the first
        // raw backlight interface if no enabled interface is found.
        for (const device of devices) {
            if (device.get_sysfs_attr('type') === 'raw' &&
                device.get_parent()?.get_sysfs_attr('enabled') === 'enabled')
                return device;
        }

        for (const device of devices) {
            if (device.get_sysfs_attr('type') === 'raw')
                return device;
        }
    }

    _updateCurBrightnessFromUdev() {
        const [success_, brightness] = this._backlightSysfsFile.load_contents(null);

        const newPwm = parseInt(new TextDecoder().decode(brightness));
        if (this._curPwm === newPwm)
            return;

        if (newPwm > this._maxPwm)
            throw new Error(`Backlight value (${newPwm}) read from udev is more then max brightness (${this._maxPwm})`);

        this._curPwm = newPwm;

        //if (!this._smoothUpdateDurationMs) {
     /*       this._targetPerceived = this._nitsToAbsPerceived(
                this._pwmToNits(this._curPwm));

            this.emit('perceived-brightness-changed');
*/
       // }
    }

    _makeNitsToPwmCurve(minMaxNits, minBrightnessPwm, brightnessScale) {
        const minNits = minMaxNits[0];
        const maxNits = minMaxNits[1];
        this._minPwm = minBrightnessPwm;
        if (this._minPwm >= this._maxPwm)
            throw new Error(`Resolved kernel backlight has max brightness ${this._maxPwm} larger than min ${this._minPwm}`);

        this._minPerceived = this._nitsToAbsPerceived(minNits);
        this._maxPerceived = this._nitsToAbsPerceived(maxNits);

        switch (brightnessScale) {
        case 'linear':
            this._nitsToPwm = n => linearMap(n,
                minNits, maxNits, this._minPwm, this._maxPwm);
            this._pwmToNits = p => linearMap(p,
                this._minPwm, this._maxPwm, minNits, maxNits);
            break;
        case 'logarithmic':
        case 'kernel-advertised':
        default:
            throw new Error(`Unsupported brightnessScale value: ${brightnessScale}`);
        }
    }

    _makeNitsToPwmCustomCurve(deviceBrightnessToNits) {
        const brightnessValues = deviceBrightnessToNits.filter((a, i) => i % 2 === 0);
        const nitsValues = deviceBrightnessToNits.filter((a, i) => i % 2 === 1);

        const minNits = nitsValues[0];
        const maxNits = nitsValues[nitsValues.length - 1];

        this._minPwm = brightnessValues[0];
        if (this._minPwm >= this._maxPwm)
            throw new Error(`Resolved kernel backlight has max brightness ${this._maxPwm} larger than min ${this._minPwm}`);

        this._minPerceived = this._nitsToAbsPerceived(minNits);
        this._maxPerceived = this._nitsToAbsPerceived(maxNits);

        const akima = new Akima();

        // Sadly akima really doesn't like large values (< 1000) in the array, so deal
        // with that by linearly mapping things a bit
        const func1 = akima.createInterpolator(nitsValues,
            brightnessValues.map(b => linearMap(b, 0, 1000, 0, 1)));
        this._nitsToPwm = n => linearMap(func1(n), 0, 1, 0, 1000);

        const func2 = akima.createInterpolator(brightnessValues, nitsValues);
        this._pwmToNits = n => func2(n);
    }

    _makeLuxToNitsCurve(deviceLuxToNits) {
        let luxValues = deviceLuxToNits.filter((a, i) => i % 2 === 0);
        let nitsValues = deviceLuxToNits.filter((a, i) => i % 2 === 1);

        const lowestLux = luxValues[0]
        const lowestNits = nitsValues[0];
        const highestLux = luxValues[luxValues.length - 1]
        const highestNits = nitsValues[nitsValues.length - 1];

        const akima = new Akima();
        this._luxToNitsCurve = akima.createInterpolator(luxValues, nitsValues);
/*
        this._luxToNitsCurve = l => {
            if (l <= lowestLux)
                return lowestNits;

            if (l >= highestLux)
                return highestNits;

            return func(l);
        };
*/
    }

    async _syncEnabled(updateNow = true) {
        const enabled = this._inhibitedCount === 0
            && this._settings.get_boolean('ambient-enabled')
            && this._sensorDaemon.ambientLightAvailable();

        log("AUTOBACKLIGHT syncing enabled: _inhibitedCount " + this._inhibitedCount + " setting-enabled " + this._settings.get_boolean('ambient-enabled') + " available " + this._sensorDaemon.ambientLightAvailable() + " final " + enabled);

        if (this._enabled === enabled)
            return;

        if (enabled) {
            this._userDeltaPerceived = 0;

            try {
                await this._sensorDaemon.claimAmbientLight();
            } catch(e) {
                console.error("AUTOBACKLIGHT failed to claim sensor: " + e);
                return;
            }

            log("AUTOBACKLIGHT claimed and enabled");

            this._enabled = true;
            if (updateNow)
                this._ambientLightLevelChanged(this, this._sensorDaemon.ambientLightLevel, 'lux');
        } else {
            this._enabled = false;

            this._history = [];
            delete this._latestLow;
            delete this._autoPerceived;

            if (this._lowerBrightnessTimeout) {
                GLib.source_remove(this._lowerBrightnessTimeout);
                delete this._lowerBrightnessTimeout;
            }

            await this._sensorDaemon.releaseAmbientLight();
        }
    }

    _smoothUpdateStep() {
        const timeNow = GLib.get_monotonic_time();
        const elapsedTimeMs = (timeNow - this._smoothUpdateBeginTime) / 1000.0;
        const isFinalUpdate = this._smoothUpdateDurationMs === 0 || elapsedTimeMs >= this._smoothUpdateDurationMs;

        if (this._inStep && !isFinalUpdate)
            return GLib.SOURCE_CONTINUE;

        let newPerceived;
        if (isFinalUpdate) {
            newPerceived = this._smoothUpdateToPerceived;
        } else {
            const delta = this._smoothUpdateToPerceived - this._smoothUpdateFromPerceived;
            const step = delta * (elapsedTimeMs / this._smoothUpdateDurationMs);
            newPerceived = this._smoothUpdateFromPerceived + step;
        }

        const newNits = this._perceivedToNits(newPerceived);
        const newPwm = Math.max(Math.min(Math.round(this._nitsToPwm(newNits)), this._maxPwm), this._minPwm);
//log("AUTOBACKLIGHT: smooth update final=" + isFinalUpdate + " newNits=" + newNits + " newPwm=" + newPwm + " newPerceived="+ newPerceived);
        if (this._lastSetPwm !== newPwm) {
            this._inStep = true;

            this._brightnessProxy.SetBrightnessAsync("backlight", this._backlightName, newPwm).catch(e => console.error(e)).finally(() => {
                this._lastSetPwm = newPwm;
                this._curPerceived = newPerceived;

                if (isFinalUpdate) {
                    delete this._lastSetPwm;
                    delete this._smoothUpdateFromPerceived;
                    delete this._smoothUpdateToPerceived;
                    delete this._smoothUpdateDurationMs;
                    delete this._smoothUpdateBeginTime;
                    delete this._smoothUpdateTimeoutId;
                }

                delete this._inStep;
            });
        } else {
            if (isFinalUpdate) {
                delete this._lastSetPwm;
                delete this._smoothUpdateFromPerceived;
                delete this._smoothUpdateToPerceived;
                delete this._smoothUpdateDurationMs;
                delete this._smoothUpdateBeginTime;
                delete this._smoothUpdateTimeoutId;
            }
        }

        return isFinalUpdate ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
    }

    // convert nits to an artificial "perceived brightness" value, see Fechners law,
    // Stevens' power law etc. This is probably not 100% correct, but it seems to
    // do the trick.
    // We use Stevens power law here: b=k*(I^a)
    //  - I is intensity of stimulus in physical units (so nits),
    //  - k is a proportionality constant that depends on the unit (so cd/m² in our case,
    //    apparently Stevens originally used 10 for "light" here, see also "Temporal
    //    constraints on visual perception: A psychophysical investigation of the relation
    //    between attention capture and the attentional blink" by Simon Nielsen).
    //    We go with 3 here because that works well for our case.
    //  - a is the exponent that depends on the kind of stimulation, 0.33 seems
    //    to be chosen for "5° target in dark". We use 0.22, which is a bit of
    //    a steeper curve (aka at low nits the perceived value varies even more,
    //    and at high nits even less).
    //  - b is the artificial "perceived brightness"
    _nitsToAbsPerceived(nits) {
        return 3 * Math.pow(nits, 0.22);
    }

    _perceivedToNits(perceived) {
        return Math.pow(perceived / 3, 1 / 0.22);
    }

    // Another fun human fact: Perception of brightness-change is not only logarithmic,
    // but also relative to the brightness the eyes are "calibrated" to, so the ambient
    // brightness.
    // The further away the screen brightness is from the ambient brightness, the
    // smaller the perceived change is, and vice-versa.
    // Since we know the ambient brightness, we can correct for that by putting a target
    // brightness close to the ambient brightness even closer to the ambient.
    // In practice this makes the brightness slider more fine-grained around the
    // ambient brightness, and more coarse around the edges.
    // The factor that drives the conversion here is the 1.5 in pow(x, 1.5).
    _absPerceivedToRelPerceived(perceived) {
        if (this._autoPerceived === undefined)
            return perceived;

        const delta = perceived - this._autoPerceived;
        let relPerceived;
        if (delta > 0) {
            const normalizedDelta = linearMap(delta, 0, this._maxPerceived - this._autoPerceived, 0, 1);
            relPerceived = Math.pow(normalizedDelta, 1.5);
            relPerceived = linearMap(relPerceived, 0, 1, 0, this._maxPerceived - this._autoPerceived);
            relPerceived = this._autoPerceived + relPerceived;
        } else if (delta < 0) {
            const normalizedDelta = linearMap(Math.abs(delta), 0, this._autoPerceived - this._minPerceived, 0, 1);
            relPerceived = Math.pow(normalizedDelta, 1.5);
            relPerceived = linearMap(relPerceived, 0, 1, 0, this._autoPerceived - this._minPerceived);
            relPerceived = this._autoPerceived - relPerceived;
        } else {
            relPerceived = this._autoPerceived;
        }

        return relPerceived;
    }

    _relPerceivedToAbsPerceived(relPerceived) {
        if (this._autoPerceived === undefined)
            return relPerceived;

        const delta = relPerceived - this._autoPerceived;
        let absPerceived;
        if (delta > 0) {
            const normalizedDelta = linearMap(delta, 0, this._maxPerceived - this._autoPerceived, 0, 1);
            absPerceived = Math.pow(normalizedDelta, 1 / 1.5);
            absPerceived = linearMap(absPerceived, 0, 1, 0, this._maxPerceived - this._autoPerceived);
            absPerceived = this._autoPerceived + absPerceived;
        } else if (delta < 0) {
            const normalizedDelta = linearMap(Math.abs(delta), 0, this._autoPerceived - this._minPerceived, 0, 1);
            absPerceived = Math.pow(normalizedDelta, 1 / 1.5);
            absPerceived = linearMap(absPerceived, 0, 1, 0, this._autoPerceived - this._minPerceived);
            absPerceived = this._autoPerceived - absPerceived;
        } else {
            absPerceived = this._autoPerceived;
        }

        return absPerceived;
    }

    _setBrightnessPerceived(target, fadeDurationMs) {
        if (this._smoothUpdateTimeoutId)
            GLib.source_remove(this._smoothUpdateTimeoutId);

        this._targetPerceivedNoOverrides = target;

        // adjust target for dimFactor
        target = this._minPerceived + ((target - this._minPerceived) * this._dimFactor);
        // adjust target for the user delta and make sure it's within the backlight range
        target = Math.max(Math.min(target + this._userDeltaPerceived, this._maxPerceived), this._minPerceived);
        // finally convert the target to relative perceived space
        target = this._absPerceivedToRelPerceived(target);

        // try to animate smoothly with 60 HZ
        const updateRateMs = 16;

        // animation also happens (linearly) in perceived space
        this._smoothUpdateFromPerceived = this._curPerceived;
        this._smoothUpdateToPerceived = target;
        this._targetPerceived = target;
        this._smoothUpdateDurationMs = fadeDurationMs;
        this._smoothUpdateBeginTime = GLib.get_monotonic_time();

        log("AUTOBACKLIGHT animating towards " + this._smoothUpdateToPerceived + " from " + this._smoothUpdateFromPerceived + " duration " + fadeDurationMs + "ms");

        this._smoothUpdateStep();

        if (this._smoothUpdateDurationMs > 0) {
            this._smoothUpdateTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_HIGH, updateRateMs, this._smoothUpdateStep.bind(this));
        }

        this.emit('perceived-brightness-changed');
    }

    // this function tries to do two things:
    // 1) adjust for fluctuating brightness over the last 30 seconds
    // and returns TRUE in case brightness actually went down and is not just within
    // the fluctuation range
    // 2) return TRUE in case brightness went down by more than a very "smooth"
    // ramp down (ie. natural ramp down during sunset). Eg in case the user
    // is moving closer to the screen and blocking a light source.
    // FIXME: this was a quick hack and could probably be improved a lot
    _analyze() {
        const [timeNowMs, levelNow] = this._history[this._history.length - 1];

        let levelAccu = 0;
        let nLevels = 0;
        let highestLevel = levelNow;
        let lowestLevel = levelNow;
        let lastTimeMs = timeNowMs;
        const tmpArr = [];

        // go backwards in time through history, ignoring the newest measurement
        for (let i = this._history.length - 2; i >= 0; i--) {
            const [timeMs, level] =  this._history[i];
            const deltaMs = timeNowMs - timeMs;

            // we look at the last 10 seconds
            if (deltaMs > 10000)
                break;

            if (level > highestLevel)
                highestLevel = level;

            if (level < lowestLevel)
                lowestLevel = level;

            const measurementDurationMs = lastTimeMs - timeMs;
            // we assign measurements a weight based on 500ms blocks (so if
            // a measurement was valid for 2 seconds, it would have weight 4).
            const measurementWeight = Math.round(measurementDurationMs / 500);

            // if the weight rounded to 0 (ie. has been valid for less than 250ms), we ignore it here
            for (let j = 0; j < measurementWeight; j++) {
                levelAccu += level;
                nLevels++;
                tmpArr.push(level);
            }

            lastTimeMs = timeMs;
        }

        if (tmpArr.length === 0)
            return false;

        const meanLevel = levelAccu / nLevels;
        const stdDev = Math.sqrt(tmpArr.map(x => Math.pow(x - meanLevel, 2)).reduce((a, b) => a + b) / nLevels)

        const fluctuationRange = stdDev;
        // either this was the most ingenious line I've ever written, or I totally didn't understand
        // what I was doing. Either way, I don't understand it anymore now...
        //const lowerThreshold = (meanLevel + ((highestLevel - meanLevel) * 0.5)) - (fluctuationRange * 2);
        const lowerThreshold = (meanLevel - ((meanLevel - lowestLevel) * 0.3)) - (fluctuationRange * 2);

     //   log("AUTOBACKLIGHT: analysis: newest: " + levelNow.toFixed(2) + ", highest: " + highestLevel.toFixed(2) + ", mean: " + meanLevel.toFixed(2) + ", stdDev: " + stdDev.toFixed(2) + ", lowerThreshold: " + lowerThreshold.toFixed(2) + ", isLower: " + (levelNow < lowerThreshold));

        if (levelNow < lowerThreshold)
            return true;

        return false;
    }

    _getAutoFadeDurationSec(fromPerceived, toPerceived, isConfirmedGoingDown) {
        const isGoingDown = toPerceived < fromPerceived;
        const perceivedDeltaAbs = Math.abs(toPerceived - fromPerceived);

        if (isConfirmedGoingDown) {
            // if brightness is going down by a lot, animate fast
            if (perceivedDeltaAbs > 2)
                return perceivedDeltaAbs * 1.3;
            // in case it's going down a little (but still abruptly),
            // animate somewhat slowly
            else if (toPerceived > this._smoothTransitionThreshPerceived)
                return perceivedDeltaAbs * 5;
            // if it's going down a little, but below the smooth transition
            // threshold, animate fast again
            else
                return perceivedDeltaAbs * 1.3;
        } else if (isGoingDown) {
            // if brightness is going down a little, and not abruptly (abrupt
            // is handled above), animate really slowly (eg during sunset).
            if (toPerceived > this._smoothTransitionThreshPerceived)
                return perceivedDeltaAbs * 6;

            return perceivedDeltaAbs * 0.8;
        } else {
            // if brightness is going up by a lot, animate fast
            if (perceivedDeltaAbs > 2)
                return perceivedDeltaAbs * 0.8;
            // if brightness is going up only a little, animate really slowly
            // (eg during sunrise).
            else if (toPerceived > this._smoothTransitionThreshPerceived)
                return perceivedDeltaAbs * 6;
            // if it's going up a little, but below the smooth transition
            // threshold, animate fast again
            else
                return perceivedDeltaAbs * 0.8;
        }
    }

    _ambientLightLevelChanged(sensorDaemon, level, unit = 'lux') {
        if (!this._enabled)
            return;

        if (unit !== 'lux')
            return;

        const timeNowMs = GLib.get_monotonic_time() / 1000;
        const lastLevel = this._history.length > 0
            ? this._history[this._history.length - 1][1]
            : -1;

        this._history.push([timeNowMs, level]);

        if (lastLevel !== -1 && Math.abs(level - lastLevel) < level * 0.01) {
            log("AUTOBACKLIGHT: level diff too small: " + Math.abs(level - lastLevel))
            return;
        }

        // try to catch any abrupt changes where the ambient light went down
        // and only apply the lower backlight brightness after a timeout.
        // this tries to catch ambient light fluctuation situations, and temporary
        // obscuring of the sensor (eg. because the user moved closer to the device)
        if (this._analyze()) {
            this._latestLow = level;

            if (!this._lowerBrightnessTimeout) {
                this._lowerBrightnessTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                    delete this._lowerBrightnessTimeout;
                    log(`AUTOBACKLIGHT: ambient brightness went down abruptly to ${this._latestLow.toFixed(2)} lux`);

                    const autoBrightnessNits = this._luxToNitsCurve(this._latestLow);
                    const autoPerceived = this._nitsToAbsPerceived(autoBrightnessNits);
                    const closeToMin = (this._curPerceived - this._minPerceived) > 0.1 && (autoPerceived - this._minPerceived) < 0.1;
                    if (this._autoPerceived === undefined || Math.abs(this._autoPerceived - autoPerceived) > 0.7 || closeToMin) {
                        const durationSec =
                            this._getAutoFadeDurationSec(this._curPerceived, autoPerceived, true);
                        this._autoPerceived = autoPerceived;
                        this._setBrightnessPerceived(autoPerceived, durationSec * 1000);
                    }

                    delete this._latestLow;
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }

        delete this._latestLow;
        if (this._lowerBrightnessTimeout) {
            GLib.source_remove(this._lowerBrightnessTimeout);
            delete this._lowerBrightnessTimeout;
        }

        const autoBrightnessNits = this._luxToNitsCurve(level);
        const autoPerceived = this._nitsToAbsPerceived(autoBrightnessNits);
        const closeToMin = (this._curPerceived - this._minPerceived) > 0.1 && (autoPerceived - this._minPerceived) < 0.1;
        const closeToMax = (this._maxPerceived - this._curPerceived) > 0.1 && (this._maxPerceived - autoPerceived) < 0.1;
        if (this._autoPerceived === undefined || Math.abs(this._autoPerceived - autoPerceived) > 0.7 || closeToMin || closeToMax) {
            log(`AUTOBACKLIGHT: ambient brightness went to ${level} lux, adjusting`);

            const durationSec =
                this._getAutoFadeDurationSec(this._curPerceived, autoPerceived, false);
            this._autoPerceived = autoPerceived;
            this._setBrightnessPerceived(autoPerceived, durationSec * 1000);
        }
    }

    inhibit() {
        this._inhibitedCount++;
        log("AUTOBACKLIGHT: inhibiting, ct now " + this._inhibitedCount);
        if (this._inhibitedCount === 1)
            this._syncEnabled();
    }

    async uninhibit(setImmediately) {
        this._inhibitedCount--;
        log("AUTOBACKLIGHT: uninhibiting, ct now " + this._inhibitedCount);
        if (this._inhibitedCount === 0) {
            await this._syncEnabled(false);

            if (this._enabled && setImmediately) {
                this._userDeltaPerceived = 0;

                const autoBrightnessNits = this._luxToNitsCurve(this._sensorDaemon.ambientLightLevel);
                const autoPerceived = this._nitsToAbsPerceived(autoBrightnessNits);
                this._autoPerceived = autoPerceived;
                this._setBrightnessPerceived(autoPerceived, 0);
            }
        }
    }

    dim(dimFactor, durationMs) {
        if (this._dimFactor === dimFactor)
            return;

        this._dimFactor = dimFactor;

        this._setBrightnessPerceived(this._targetPerceivedNoOverrides, durationMs);
    }

    undim(durationMs) {
        if (this._dimFactor === 1.0)
            return;

        this._dimFactor = 1.0;
        this._setBrightnessPerceived(this._targetPerceivedNoOverrides, durationMs);
    }

    setManually(perceivedBrightnessPercent) {
        const targetPerceived = linearMap(perceivedBrightnessPercent,
            0, 1, this._minPerceived, this._maxPerceived);

        const curPerceived = this._targetPerceivedNoOverrides;
        const deltaPerceived = targetPerceived - curPerceived;

        this._userDeltaPerceived = deltaPerceived;

        this._setBrightnessPerceived(this._targetPerceivedNoOverrides, 0);
    }

    getPerceivedBrightness() {
        return this._relPerceivedToAbsPerceived(this._targetPerceived);
    }

    getPerceivedBrightnessPercent() {
        const mapped =
            linearMap(this.getPerceivedBrightness(), this._minPerceived, this._maxPerceived, 0, 1);

        return Math.min(Math.max(mapped, 0), 1);
    }
}
