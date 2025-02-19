import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting } from "@scrypted/sdk";
import { Vlan } from "./vlan";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import crypto from 'crypto';
import fs from 'fs';
import { getInterfaceName } from "./interface-name";
import yaml from 'yaml';
import { NetplanConfig } from "./netplan";
import { runCommand } from "./cli";

export class Networks extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    vlans = new Map<string, Vlan>();

    // this isn't actually persisted. just used for getCreateDeviceSettings ergononmics.
    vlanStorageSettings = new StorageSettings(this, {
        name: {
            title: 'Name',
            type: 'string',
        },
        vlanId: {
            title: 'VLAN ID',
            type: 'number',
            description: 'The VLAN ID to use for this network interface. The default VLAN ID is 1.',
        },
    });

    constructor(nativeId: ScryptedNativeId) {
        super(nativeId);

        for (const nativeId of sdk.deviceManager.getNativeIds()) {
            if (nativeId?.startsWith('sv')) {
                this.getDevice(nativeId);
            }
        }

        this.regenerateInterfaces();
    }

    async regenerateInterfaces() {
        const allParents = new Set<string>()

        const bringup = new Set<Vlan>();
        const needParentInterfaces = new Set<string>();

        const netplan: NetplanConfig = {
            network: {
                version: 2,
                ethernets: {
                },
                vlans: {
                },
            }
        };


        for (const vlan of this.vlans.values()) {
            const vlanId = vlan.storageSettings.values.vlanId;
            if (!vlanId) {
                vlan.console.warn('VLAN ID is required.');
                continue;
            }

            const parentInterface = vlan.storageSettings.values.parentInterface;
            if (!parentInterface) {
                vlan.console.warn('Parent Interface is required.');
                continue;
            }

            allParents.add(parentInterface);

            const { addresses, dhcpMode } = vlan.storageSettings.values;
            if (!addresses.length && dhcpMode !== 'Client') {
                vlan.console.warn('Address is required if DHCP Mode is not Client.');
                continue;
            }

            bringup.add(vlan);

            const interfaceName = getInterfaceName(parentInterface, vlanId);

            const dhcp4 = dhcpMode == 'Client';
            const dhcp6 = dhcpMode == 'Client';
            if (vlanId === 1) {
                netplan.network.ethernets![parentInterface] = {
                    addresses: addresses.length ? addresses : undefined,
                    optional: true,
                    dhcp4,
                    dhcp6,
                }
            }
            else {
                needParentInterfaces.add(parentInterface);
                netplan.network.vlans![interfaceName] = {
                    link: parentInterface,
                    id: vlanId,
                    addresses: addresses.length ? addresses : undefined,
                    optional: true,
                    dhcp4,
                    dhcp6,
                }
            }
        }

        for (const parentInterface of needParentInterfaces) {
            if (netplan.network.ethernets![parentInterface])
                continue;
            netplan.network.ethernets![parentInterface] = {
                dhcp4: false,
                dhcp6: false,
                optional: true,
            }
        }

        // dnsmasq -d -i eth1.10:svdff7 -z --dhcp-range=192.168.10.100,192.168.10.200,12h --dhcp-option=6,192.168.10.1

        // iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
        // iptables -A FORWARD -i eth1.10 -o eth0 -j ACCEPT
        // iptables -A FORWARD -i eth0 -o eth1.10 -m state --state RELATED,ESTABLISHED -j ACCEPT

        await fs.promises.writeFile(`/etc/netplan/01-scrypted.yaml`, yaml.stringify(netplan), {
            mode: 0o600,
        });
        await runCommand('netplan', ['apply'], this.console);

        for (const vlan of bringup) {
            await vlan.initializeNetworkInterface();
        }
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId) {
        if (!sdk.systemManager.getDeviceById(id)) {
            const vlan = this.vlans.get(nativeId!);
            if (vlan) {
                this.vlans.delete(nativeId!);
                vlan.storageSettings.values.parentInterface = undefined;
                vlan.initializeNetworkInterface();
            }
        }
    }

    async getDevice(nativeId: string) {
        let ret = this.vlans.get(nativeId);
        if (!ret) {
            ret = new Vlan(this, nativeId);
            this.vlans.set(nativeId, ret);
        }
        return ret;
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return this.vlanStorageSettings.getSettings();
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const nativeId = `sv${crypto.randomBytes(2).toString('hex')}`;
        let { vlanId, name } = settings;
        name = name?.toString() || `VLAN ${vlanId}`;
        vlanId = parseInt(vlanId as any);
        if (!vlanId || vlanId < 1 || vlanId > 4095)
            throw new Error('Invalid VLAN ID');
        this.validateNetworkUnused(vlanId);
        const id = await sdk.deviceManager.onDeviceDiscovered({
            nativeId,
            providerNativeId: this.nativeId,
            interfaces: [
                ScryptedInterface.Settings,
            ],
            type: ScryptedDeviceType.Builtin,
            name,
        });

        const device = await this.getDevice(nativeId);
        device.storageSettings.values.vlanId = vlanId;
        return id;
    }

    validateNetworkUnused(vlanId: number, allow?: Vlan) {
        for (const vlan of this.vlans.values()) {
            if (vlan.storageSettings.values.vlanId === vlanId && vlan !== allow)
                throw new Error(`VLAN ID ${vlanId} already in use.`);
        }
    }
}
