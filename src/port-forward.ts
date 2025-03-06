import { ScryptedDeviceBase, ScryptedNativeId, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDevice } from "@scrypted/sdk/storage-settings";
import { Vlan } from "./vlan";

export function getPortForwardSettings(device: StorageSettingsDevice){
    const ret = new StorageSettings(device, {
        protocol: {
            title: 'Protocol',
            description: 'The protocol to forward.',
            type: 'radiopanel',
            choices: ['tcp + udp', 'tcp', 'udp', 'http(s)'],
            defaultValue: 'tcp',
        },
        srcPort: {
            radioGroups: ['tcp + udp', 'tcp', 'udp'],
            title: 'Source Port',
            description: 'The incoming WAN port. Accepts nftables set notation for multiple ports.',
        },
        dstIp: {
            radioGroups: ['tcp + udp', 'tcp', 'udp'],
            title: 'Destination IP',
            description: 'The destomation LAN IP. Accepts nftables set notation for multiple ports.',
            type: 'string',
        },
        dstPort: {
            radioGroups: ['tcp + udp', 'tcp', 'udp'],
            title: 'Destination Port',
            description: 'The destination LAN port.',
        },
        srcDomain: {
            radioGroups: ['http(s)'],
            title: 'Domain',
            description: 'The domain to reverse proxy.',
        },
        dstAddress: {
            radioGroups: ['http(s)'],
            title: 'Destination Address',
            description: 'The reverse proxy address.',
        },
        dnsSetup: {
            radioGroups: ['http(s)'],
            title: 'DNS Configuration',
            description: 'Configure DNS manually or automatically with a selected provider.',
            type: 'radiopanel',
            choices: ['Manual', 'Cloudflare'],
            defaultValue: 'Manual',
        },
        cloudflareDns: {
            radioGroups: ['Cloudflare'],
            title: 'Cloudflare Authentication',
            description: 'Provide a Cloudflare authentication token to manage this domain.',
        }
    });
    return ret;
}

export class PortForward extends ScryptedDeviceBase implements Settings {
    storageSettings = getPortForwardSettings(this);

    constructor(public internet: Vlan, nativeId: ScryptedNativeId) {
        super(nativeId);

        this.updateInfo();
    }

    updateInfo() {
        this.info = {
            description: `${this.storageSettings.values.protocol || 'unconfigured'} port ${this.storageSettings.values.srcPort || 'unconfigured'} to ${this.storageSettings.values.dstIp || 'unconfigured ip'}:${this.storageSettings.values.dstPort || 'unconfigured port'}`,
        }
    }

    async getSettings() {
        const ret = await this.storageSettings.getSettings();
        return ret;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);
        this.updateInfo();
    }
}
