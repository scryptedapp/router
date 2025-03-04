import { ScryptedDeviceBase, ScryptedNativeId, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDevice } from "@scrypted/sdk/storage-settings";

export function getAddressReservationSettings(device: StorageSettingsDevice) {
    const ret = new StorageSettings(device, {
        mac: {
            title: 'MAC Address',
            description: 'The MAC address to reserve.',
            type: 'string',
        },
        ip: {
            title: 'IP Address',
            description: 'The IP address to reserve.',
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
