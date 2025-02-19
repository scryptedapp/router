import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting } from "@scrypted/sdk";
import { Vlan } from "./vlan";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import crypto from 'crypto';
import fs from 'fs';
import { getInterfaceName } from "./interface-name";

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
        const defaultVlans = new Set<string>();

        let interfaces = '';
        for (const vlan of this.vlans.values()) {
            const vlanId = vlan.storageSettings.values.vlanId;
            if (!vlanId)
                continue;

            const parentInterface = vlan.storageSettings.values.parentInterface;
            if (!parentInterface)
                continue;

            allParents.add(parentInterface);

            const address = vlan.storageSettings.values.address;
            if (!address)
                continue;

            bringup.add(vlan);

            const interfaceName = getInterfaceName(parentInterface, vlanId);
            if (vlanId === 1)
                defaultVlans.add(parentInterface);
            // const interfaceName = `${vlan.nativeId}`;

            interfaces += `
allow-hotplug ${interfaceName}
iface ${interfaceName} inet static
    address ${address}
    netmask 255.255.255.0
`;
        }

        let parentInterfaces = '';
        for (const parentInterface of allParents) {
            if (defaultVlans.has(parentInterface))
                continue;
            parentInterfaces += `
iface ${parentInterface} inet manual

`;
        }

        interfaces = parentInterfaces + interfaces;

        // dnsmasq -d -i eth1.10:svdff7 -z --dhcp-range=192.168.10.100,192.168.10.200,12h --dhcp-option=6,192.168.10.1

        // iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
        // iptables -A FORWARD -i eth1.10 -o eth0 -j ACCEPT
        // iptables -A FORWARD -i eth0 -o eth1.10 -m state --state RELATED,ESTABLISHED -j ACCEPT

        // await fs.promises.writeFile(`/etc/network/interfaces.d/${this.nativeId}`, interfaces);        
        await fs.promises.writeFile(`/etc/network/interfaces`, interfaces);

        for (const vlan of bringup) {
            await vlan.initializeNetworkInterface();
        }
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId) {
        if (!sdk.systemManager.getDeviceById(id)) {
            const vlan = this.vlans.get(nativeId!);
            if (vlan) {
                this.vlans.delete(nativeId!);
                vlan.storageSettings.values.address = undefined;
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
