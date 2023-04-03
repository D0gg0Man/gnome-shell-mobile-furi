import {DBusService} from './dbusService.js';
import {SensorDaemon} from './sensorDaemon.js';
import {SensorDaemonService} from './sensorDaemonService.js';
import {ProximityMonitoring} from './proximityMonitoring.js';
import {CallsMonitoring} from './callsMonitoring.js';

/** @returns {void} */
export async function main() {
    const sensorDaemon = new SensorDaemon();
    const proximityMonitoring = new ProximityMonitoring(sensorDaemon);
    const callsMonitoring = new CallsMonitoring(proximityMonitoring);

    const sensorDaemonService = new SensorDaemonService(sensorDaemon, proximityMonitoring);

    const service = new DBusService('org.gnome.Shell.SensorDaemon', sensorDaemonService);

    await service.runAsync();
}
