import { ScryptedDeviceBase, ScryptedNativeId, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDevice } from "@scrypted/sdk/storage-settings";

export function getPortForwardSettings(device: StorageSettingsDevice){
    const ret = new StorageSettings(device, {
        protocol: {
            title: 'Protocol',
            description: 'The protocol to forward.',
            type: 'string',
            choices: ['tcp + udp', 'tcp', 'udp', 'https'],
            defaultValue: 'tcp',
        },
        srcPort: {
            title: 'Source Port',
            description: 'The incoming WAN port. Accepts nftables set notation for multiple ports.',
        },
        dstIp: {
            title: 'Destination IP',
            description: 'The destomation LAN IP. Accepts nftables set notation for multiple ports.',
            type: 'string',
        },
        dstPort: {
            title: 'Destination Port',
            description: 'The destination LAN port.',
        },
    });
    return ret;
}

export class PortForward extends ScryptedDeviceBase implements Settings {
    storageSettings = getPortForwardSettings(this);

    constructor(nativeId: ScryptedNativeId) {
        super(nativeId);

        this.updateInfo();
    }

    updateInfo() {
        this.info = {
            description: `${this.storageSettings.values.protocol || 'unconfigured'} port ${this.storageSettings.values.srcPort || 'unconfigured'} to ${this.storageSettings.values.dstIp || 'unconfigured ip'}:${this.storageSettings.values.dstPort || 'unconfigured port'}`,
        }
    }

    async getSettings() {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);
        this.updateInfo();
    }
}
