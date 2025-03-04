import { ScryptedDeviceBase, ScryptedNativeId, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDevice } from "@scrypted/sdk/storage-settings";

export function getAddressReservationSettings(device: StorageSettingsDevice) {
    const ret = new StorageSettings(device, {
        host: {
            title: 'Host',
            description: 'The reserved DNS host name. Defaults to the friendly name.',
        },
        mac: {
            title: 'MAC Address',
            description: 'The MAC address of the device.',
            type: 'string',
        },
        ip: {
            title: 'IP Address',
            description: 'The reserved IP address.',
            type: 'string',
        },
    });
    return ret;
}

export class AddressReservation extends ScryptedDeviceBase implements Settings {
    storageSettings = getAddressReservationSettings(this);

    constructor(nativeId: ScryptedNativeId) {
        super(nativeId);

        this.updateInfo();
        this.storageSettings.settings.host.mapGet = (value) => {
            return value || this.name;
        };
    }

    updateInfo() {
        this.info = {
            mac: this.storageSettings.values.mac,
            ip: this.storageSettings.values.ip,
        };
    }

    async getSettings() {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue) {
        await this.storageSettings.putSetting(key, value);
        this.updateInfo();
    }
}
