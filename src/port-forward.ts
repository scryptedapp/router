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
            description: 'Cloudflare token used for the DNS-01 challenge to verify domain ownership.',
        },
        caddyfile: {
            radioGroups: ['http(s)'],
            title: 'Caddyfile',
            description: 'Additional configuration to place inside the Caddyfile block for this domain.',
            type: 'textarea',
            defaultValue: '',
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
        if (this.storageSettings.values.protocol === 'http(s)') {
            this.info = {
                description: `${this.storageSettings.values.dstAddress || (this.storageSettings.values.caddyfile ? 'custom Caddyfile' : 'unconfigured address')}`,
            }
        }
        else {
            this.info = {
                description: `${this.storageSettings.values.protocol || 'unconfigured'} port ${this.storageSettings.values.srcPort || 'unconfigured'} to ${this.storageSettings.values.dstIp || 'unconfigured ip'}:${this.storageSettings.values.dstPort || 'unconfigured port'}`,
            }
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
