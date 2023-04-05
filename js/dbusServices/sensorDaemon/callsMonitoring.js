import Gio from 'gi://Gio';

import {loadInterfaceXML} from './misc/dbusUtils.js';
import * as ObjectManager from './misc/objectManager.js';

const CallIface = loadInterfaceXML('org.gnome.Calls.Call');
const CallProxy = Gio.DBusProxy.makeProxyWrapper(CallIface);

export const CallsMonitoring = class {
    constructor(proximityMonitoring) {
        this._proximityMonitoring = proximityMonitoring;

        this._calls = [];
        this._inCall = false;

        this._objectManager = new ObjectManager.ObjectManager({
            connection: Gio.DBus.session,
            name: 'org.gnome.Calls',
            objectPath: '/org/gnome/Calls',
            knownInterfaces: [CallIface],
            onLoaded: this._onLoaded.bind(this),
        });
    }

    _onLoaded() {
        const callProxies = this._objectManager.getProxiesForInterface('org.gnome.Calls.Call');
        for (const callProxy of callProxies)
            this._calls.push(callProxy);

        this._updateInCall();

        this._objectManager.connect('object-added', (objectManager, objectPath) => {
            if (objectPath.startsWith('/org/gnome/Calls/Call'))
                this._addCall(this._objectManager.getProxy(objectPath, 'org.gnome.Calls.Call'));
        });

        this._objectManager.connect('object-removed', (objectManager, objectPath) => {
            if (objectPath.startsWith('/org/gnome/Calls/Call'))
                this._removeCall(this._objectManager.getProxy(objectPath, 'org.gnome.Calls.Call'));
        });
    }

    _updateInCall() {
        // active, dialing, alerting states are considered in-call
        const inCall = this._calls.some(c =>
            c.State === 1 || c.State === 3 || c.State === 4);

        if (this._inCall === inCall)
            return;

        this._inCall = inCall;

        if (inCall)
            this._proximityMonitoring.startMonitoring();
        else
            this._proximityMonitoring.stopMonitoring();
    }

    _addCall(callProxy) {
        callProxy.connect('g-properties-changed', (proxy, properties) => {
            for (const prop in properties.deepUnpack()) {
                if (prop !== 'State')
                    return;

                this._updateInCall();
            }
        });

        this._calls.push(callProxy);
        this._updateInCall();
    }

    _removeCall(callProxy) {
        if (!this._calls.includes(callProxy))
            return;

        this._calls.splice(this._calls.indexOf(callProxy), 1);
        this._updateInCall();
    }
}
