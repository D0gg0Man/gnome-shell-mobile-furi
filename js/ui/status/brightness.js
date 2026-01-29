import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {QuickSlider, SystemIndicator} from '../quickSettings.js';
import * as Main from '../main.js';
import * as PopupMenu from '../popupMenu.js';
import {Slider} from '../slider.js';

import {loadInterfaceXML} from '../../misc/fileUtils.js';

const BRIGHTNESS_NAME = _('Brightness');

const BUS_NAME = 'org.gnome.Shell.SensorDaemon';
const OBJECT_PATH = '/org/gnome/Shell/SensorDaemon';

const BrightnessInterface = loadInterfaceXML('org.gnome.Shell.SensorDaemon');
const BrightnessProxy = Gio.DBusProxy.makeProxyWrapper(BrightnessInterface);

const BrightnessItem = GObject.registerClass(
class BrightnessItem extends QuickSlider {
    _init() {
        super._init({
            iconName: 'display-brightness-symbolic',
            menuButtonAccessibleName: _('Open brightness menu'),
        });

        this._proxy = new BrightnessProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
            (proxy, error) => {
                if (error)
                    console.error(error.message);
                else
                    this._proxy.connect('g-properties-changed', () => this._sync());
                this._sync();
            });

        this._sliderChangedId = this.slider.connect('notify::value',
            this._sliderChanged.bind(this));
        this.slider.accessible_name = _('Brightness');
    }

    _sliderChanged() {
        this._proxy.SetBacklightManuallyAsync(this.slider.value);
    }

    _changeSlider(value) {
        this.slider.block_signal_handler(this._sliderChangedId);
        this.slider.value = value;
        this.slider.unblock_signal_handler(this._sliderChangedId);
    }

    _sync() {
        const brightness = this._proxy.BacklightBrightness;
        this.visible = brightness >= 0;
        if (this.visible)
            this._changeSlider(brightness);
    }
});

export const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init() {
        super._init();

        this.quickSettingsItems.push(new BrightnessItem());
    }
});
