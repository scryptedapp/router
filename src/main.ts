import sdk, { DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId } from '@scrypted/sdk';
import { Networks } from './networks';
import path from 'path';
import fs from 'fs';

class ScryptedRouter extends ScryptedDeviceBase implements DeviceProvider {
    networks!: Networks;

    constructor(nativeId?: string) {
        super(nativeId);

        this.reportDevices();

        this.prepareDirectories();
    }

    async prepareDirectories() {
        const usbmuxdDataDir = path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, 'usbmuxd');
        await fs.promises.mkdir(usbmuxdDataDir, { recursive: true });
    }

    initializeDevices() {
        this.networks ||= new Networks('networks');
    }

    async reportDevices() {
        await sdk.deviceManager.onDevicesChanged({
            devices: [{
                nativeId: 'networks',
                name: 'Networks',
                type: ScryptedDeviceType.Builtin,
                interfaces: [
                    ScryptedInterface.DeviceProvider,
                    ScryptedInterface.DeviceCreator,
                    ScryptedInterface.ScryptedSystemDevice,
                    ScryptedInterface.ScryptedDeviceCreator,
                    ScryptedInterface.Settings,
                ],
            }]
        });
        this.initializeDevices();
    }

    async getDevice(nativeId: string) {
        if (nativeId === 'networks')
            return this.networks ||= new Networks('networks');
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId) {
    }
}

export default ScryptedRouter;
