import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting } from "@scrypted/sdk";
import { Vlan } from "./vlan";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import crypto from 'crypto';
import fs from 'fs';
import { getInterfaceName } from "./interface-name";
import yaml from 'yaml';
import { NetplanConfig } from "./netplan";
import { runCommand } from "./cli";
import os from 'os';
export class Networks extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    vlans = new Map<string, Vlan>();

    constructor(nativeId: ScryptedNativeId) {
        super(nativeId);

        this.systemDevice = {
            deviceCreator: 'Network',
        }

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

            const { addresses, dhcpMode, dnsServers } = vlan.storageSettings.values;
            if (!addresses.length && dhcpMode !== 'Client') {
                vlan.console.warn('Address is required if DHCP Mode is not Client.');
                continue;
            }

            bringup.add(vlan);

            const interfaceName = getInterfaceName(parentInterface, vlanId);

            const dhcp4 = dhcpMode == 'Client' && !!vlan.storageSettings.values.dhcp4;
            const dhcp6 = dhcpMode == 'Client' && !!vlan.storageSettings.values.dhcp6;
            const acceptRa = dhcpMode == 'Client' && !!vlan.storageSettings.values.acceptRa;

            const nameservers = dnsServers?.length ? {
                addresses: dnsServers,
            } : undefined;

            if (vlanId === 1) {
                netplan.network.ethernets![parentInterface] = {
                    addresses: addresses.length ? addresses : undefined,
                    nameservers,
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
                    nameservers,
                    optional: true,
                    dhcp4,
                    dhcp6,
                    "accept-ra": acceptRa,
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
        const disallowed = new Set<string>();
        disallowed.add('lo');

        // this isn't actually persisted. just used for getCreateDeviceSettings ergononmics.
        const vlanStorageSettings = new StorageSettings(this, {
            name: {
                title: 'Name',
                type: 'string',
            },
            parentInterface: {
                title: 'Network Interface',
                choices: Object.keys(os.networkInterfaces()).filter(k => !disallowed.has(k)),
            },
            vlanId: {
                title: 'VLAN ID',
                type: 'number',
                description: 'The VLAN ID to use for this network interface. The default VLAN ID is 1.',
            },
        });
        return vlanStorageSettings.getSettings();
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const nativeId = `sv${crypto.randomBytes(2).toString('hex')}`;
        let { vlanId, name, parentInterface } = settings;
        name = name?.toString() || `VLAN ${vlanId}`;
        vlanId = parseInt(vlanId as any);
        parentInterface = parentInterface?.toString();
        if (!parentInterface)
            throw new Error('Network Interface is required.');
        if (!vlanId || vlanId < 1 || vlanId > 4095)
            throw new Error('Invalid VLAN ID');
        this.validateNetworkUnused(parentInterface, vlanId);
        const id = await sdk.deviceManager.onDeviceDiscovered({
            nativeId,
            providerNativeId: this.nativeId,
            interfaces: [
                ScryptedInterface.Settings,
            ],
            type: "Network" as ScryptedDeviceType,
            name,
        });

        const device = await this.getDevice(nativeId);
        device.storageSettings.values.vlanId = vlanId;
        device.storageSettings.values.parentInterface = parentInterface;
        return id;
    }

    validateNetworkUnused(parentInterface: string, vlanId: number, allow?: Vlan) {
        for (const vlan of this.vlans.values()) {
            if (parentInterface === vlan.storageSettings.values.parentInterface && vlan.storageSettings.values.vlanId === vlanId && vlan !== allow)
                throw new Error(`VLAN ID ${vlanId} already in use.`);
        }
    }
}
