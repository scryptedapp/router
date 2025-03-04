import path from 'path';
import sdk, { AdoptDevice, DeviceCreator, DeviceCreatorSettings, DeviceDiscovery, DeviceProvider, DiscoveredDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, ScryptedSystemDevice, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { getInterfaceName } from './interface-name';
import type { Networks } from "./networks";
import { getPortForwardSettings, PortForward } from "./port-forward";
import { getServiceFile, removeServiceFile, systemctlDaemonReload, systemctlDisable, systemctlEnable, systemctlRestart, systemctlStop } from "./systemd";
import { AddressReservation, getAddressReservationSettings } from "./address-reservation";


function findInterfaceAddress(name: string) {
    const interfaces = os.networkInterfaces();
    for (const [key, value] of Object.entries(interfaces)) {
        if (key === name) {
            return value?.[0]?.address;
        }
    }
    return undefined;

}

export class Vlan extends ScryptedDeviceBase implements Settings, DeviceProvider, DeviceCreator, ScryptedSystemDevice, DeviceDiscovery {
    storageSettings = new StorageSettings(this, {
        parentInterface: {
            title: 'Network Interface',
            mapPut: (ov, nv) => {
                this.networks.validateNetworkUnused(this.storageSettings.values.parentInterface, nv, this);
                return nv;
            },
        },
        vlanId: {
            title: 'VLAN ID',
            type: 'number',
            defaultValue: 1,
            description: 'The VLAN ID to use for this network interface. The default VLAN ID is 1.',
            mapPut: (ov, nv) => {
                this.networks.validateNetworkUnused(this.storageSettings.values.parentInterface, nv, this);
                return nv;
            },
        },

        dnsServers: {
            title: 'DNS Servers',
            type: 'string',
            description: 'The DNS servers to use for this network interface.',
            multiple: true,
            combobox: true,
            choices: [
                // cloudflare
                '1.1.1.1',
                '1.0.0.1',
                '2606:4700:4700::1111',
                '2606:4700:4700::1001',

                // google
                '8.8.8.8',
                '8.8.4.4',
                '2001:4860:4860::8888',
                '2001:4860:4860::8844',
            ],
            defaultValue: [
            ],
        },

        dhcpMode: {
            title: 'Address Configuration',
            description: 'The Address Configuration to use for this network interface.',
            choices: [
                'Auto',
                'Manual',
            ],
            defaultValue: 'Manual',
            type: 'radiopanel',
        },
        addresses: {
            title: 'Address',
            radioGroups: ['Manual'],
            type: 'string',
            description: 'IPv4 or IPv6 address of this network interface.',
            placeholder: 'E.g.: 192.168.10.1/24, 2001:abc:def::de/64',
            multiple: true,
            defaultValue: [],
        },

        gatewayMode: {
            title: 'Internet Gateway',
            radioGroups: ['Manual'],
            type: 'radiobutton',
            choices: ['Disabled', 'Local Interface', 'Manual'],
        },

        internet: {
            title: 'Local Interface',
            radioGroups: ['Local Interface'],
            description: 'The local interface that acts as a internet gateway for this network.',
        },

        gateway4: {
            title: 'Gateway IPv4',
            radioGroups: ['Internet Gateway:Manual'],
            type: 'string',
            description: 'The IPv4 gateway for this network interface.',
            placeholder: '192.168.10.1',
        },

        gateway6: {
            title: 'Gateway IPv6',
            radioGroups: ['Internet Gateway:Manual'],
            type: 'string',
            description: 'The IPv6 gateway for this network interface.',
            placeholder: '2001:db8::1',
        },

        dhcp4: {
            title: 'DHCPv4',
            radioGroups: ['Auto'],
            type: 'boolean',
            description: 'Enable DHCPv4 for this network interface.',
            defaultValue: true,
        },
        dhcp6: {
            title: 'DHCPv6',
            radioGroups: ['Auto'],
            type: 'boolean',
            description: 'Enable DHCPv6 for this network interface.',
            defaultValue: true,
        },
        acceptRa: {
            title: 'Accept Router Advertisements',
            radioGroups: ['Auto'],
            type: 'boolean',
            description: 'Accept Router Advertisements for this network interface.',
            defaultValue: true,
        },

        dhcpServer: {
            title: 'DHCP Server',
            type: 'radiobutton',
            radioGroups: ['Manual'],
            choices: ['Enabled', 'Disabled'],
            description: 'Enable DHCP server for this network interface. This will override the DHCP Client setting.',
            defaultValue: false,
        },
        dhcpRanges: {
            title: 'DHCP Server Ranges',
            radioGroups: ['Enabled'],
            type: 'string',
            description: 'The DHCP range to use for this network interface. If not specified, a default range between will be used. E.g.: 192.168.10.10,192.168.10.200,12h',
            placeholder: '192.168.10.10,192.168.10.200,12h',
            multiple: true,
        },

        applyChanges: {
            title: 'Apply Changes',
            type: 'button',
            onPut: () => {
                this.networks.regenerateInterfaces(this.console);
            },
            console: true,
        }
    });

    constructor(public networks: Networks, nativeId: ScryptedNativeId) {
        super(nativeId);

        this.storageSettings.settings.parentInterface.onGet = async () => {
            const disallowed = new Set<string>();
            disallowed.add(getInterfaceName(this.storageSettings.values.parentInterface, this.storageSettings.values.vlanId));
            disallowed.add('lo');
            return {
                choices: Object.keys(os.networkInterfaces()).filter(k => !disallowed.has(k)),
            }
        };

        this.storageSettings.settings.internet.onGet = async () => {
            const disallowed = new Set<string>();
            disallowed.add(getInterfaceName(this.storageSettings.values.parentInterface, this.storageSettings.values.vlanId));
            disallowed.add('lo');
            disallowed.add(this.storageSettings.values.parentInterface);
            return {
                choices: [
                    ...Object.keys(os.networkInterfaces()).filter(k => !disallowed.has(k)),
                ],
            }
        };

        this.updateInfo();
    }

    async getDevice(nativeId: ScryptedNativeId) {
        if (nativeId?.startsWith('pf'))
            return new PortForward(nativeId);
        else if (nativeId?.startsWith('ar'))
            return new AddressReservation(nativeId);
    }

    async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
        await systemctlDisable('vlan', nativeId!, this.console);
        await systemctlStop('vlan', nativeId!, this.console);
        await removeServiceFile('vlan', nativeId!, this.console);
        await systemctlDaemonReload(this.console);
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        if (this.providedType === ScryptedDeviceType.Internet) {
            const ret = getPortForwardSettings(this);
            const settings = await ret.getSettings();
            settings.unshift({
                key: 'name',
                title: 'Name',
                description: 'Friendly name for this port forward rule.',
            });
            return settings;
        }
        else if (this.providedType === ScryptedDeviceType.Network && this.storageSettings.values.dhcpServer === 'Enabled') {
            const ret = getAddressReservationSettings(this);
            const settings = await ret.getSettings();
            settings.unshift({
                key: 'name',
                title: 'Name',
                description: 'Friendly name for this port forward rule.',
            });
            return settings;
        }
        throw new Error('Unexpected device type.');
    }

    get leaseFile() {
        return path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, `dnsmasq-${this.nativeId}.leases`);
    }

    async discoverDevices(): Promise<DiscoveredDevice[]> {
        // read the lease file and parse it
        const leases = await fs.promises.readFile(this.leaseFile, 'utf8');
        const lines = leases.split('\n');
        const devices: DiscoveredDevice[] = [];
        for (const line of lines) {
            if (!line)
                continue;
            const parts = line.split(' ');
            const mac = parts[1];
            const ip = parts[2];
            const host = parts[3];
            devices.push({
                name: host,
                nativeId: mac,
                description: mac,
                type: ScryptedDeviceType.Network,
                interfaces: [
                    ScryptedInterface.Settings,
                ],
                info: {
                    mac,
                    ip,
                },
            });
        }
        return devices;
    }

    async adoptDevice(device: AdoptDevice): Promise<string> {
        const discovered = (await this.discoverDevices()).find(d => d.nativeId === device.nativeId);
        if (!discovered)
            throw new Error('Device not found');
        const settings: DeviceCreatorSettings = {
            name: discovered.name,
            mac: discovered.info!.mac,
            ip: discovered.info!.ip,
        };
        return this.createDevice(settings);
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        if (this.providedType === ScryptedDeviceType.Internet) {

            const nativeId = `pf${crypto.randomBytes(2).toString('hex')}`;
            const id = await sdk.deviceManager.onDeviceDiscovered({
                providerNativeId: this.nativeId,
                name: settings?.name as string,
                nativeId,
                type: "Port Forward" as ScryptedDeviceType,
                interfaces: [
                    ScryptedInterface.Settings
                ],
            });
            const portForward = new PortForward(nativeId);
            portForward.storageSettings.values.protocol = settings.protocol;
            portForward.storageSettings.values.srcPort = settings.srcPort;
            portForward.storageSettings.values.dstIp = settings.dstIp;
            portForward.storageSettings.values.dstPort = settings.dstPort;
            return id;
        }
        else if (this.providedType === ScryptedDeviceType.Network && this.storageSettings.values.dhcpServer === 'Enabled') {
            const nativeId = `ar${crypto.randomBytes(2).toString('hex')}`;
            const id = await sdk.deviceManager.onDeviceDiscovered({
                providerNativeId: this.nativeId,
                name: settings?.name as string,
                nativeId,
                type: ScryptedDeviceType.Network,
                interfaces: [
                    ScryptedInterface.Settings
                ],
            });
            const addressReservation = new AddressReservation(nativeId);
            addressReservation.storageSettings.values.mac = settings.mac;
            addressReservation.storageSettings.values.ip = settings.ip;
            return id;
        }
        throw new Error('Unexpected device type.');
    }

    getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);

        this.updateInfo();
    }

    updateInfo() {
        const interfaces = [
            ScryptedInterface.Settings,
            ScryptedInterface.ScryptedSystemDevice,
        ];

        if (this.providedType === ScryptedDeviceType.Internet) {
            interfaces.push(
                ScryptedInterface.DeviceProvider,
                ScryptedInterface.DeviceCreator,
            );

            this.systemDevice = {
                deviceCreator: 'Port Forward',
            }
        }
        else if (this.providedType === ScryptedDeviceType.Network && this.storageSettings.values.dhcpServer === 'Enabled') {
            interfaces.push(
                ScryptedInterface.DeviceProvider,
                ScryptedInterface.DeviceCreator,
                ScryptedInterface.DeviceDiscovery,
            );

            this.systemDevice = {
                deviceCreator: 'Address Reservation',
                deviceDiscovery: 'DHCP Client',
            }
        }

        const interfaceName = getInterfaceName(this.storageSettings.values.parentInterface, this.storageSettings.values.vlanId);
        sdk.deviceManager.onDeviceDiscovered({
            providerNativeId: this.networks.nativeId,
            interfaces,
            type: this.providedType!,
            name: this.providedName!,
            nativeId: this.nativeId,
            info: {
                ip: findInterfaceAddress(interfaceName),
                description: `VLAN ${this.storageSettings.values.vlanId} on ${this.storageSettings.values.parentInterface}`,
            }
        });

        if (this.providedType == 'Internet' as ScryptedDeviceType) {
            this.storageSettings.values.gatewayMode = 'Manual';
            // this.storageSettings.settings.gatewayMode.type = 'radiopanel';
            this.storageSettings.settings.gatewayMode.hide = true;
            this.storageSettings.settings.internet.hide = true;
            this.storageSettings.settings.gateway4.radioGroups = ['Manual'];
            this.storageSettings.settings.gateway6.radioGroups = ['Manual'];
            this.storageSettings.settings.dhcpServer.hide = true;
            this.storageSettings.settings.dhcpRanges.hide = true;
        }
    }

    async initializeNetworkInterface() {
        const interfaceName = getInterfaceName(this.storageSettings.values.parentInterface, this.storageSettings.values.vlanId);
        const serviceFile = getServiceFile('vlan', this.nativeId!);

        if (!this.storageSettings.values.parentInterface || !this.storageSettings.values.parentInterface) {
            await removeServiceFile('vlan', this.nativeId!, this.console);
        }
        else {
            // await ifup(interfaceName, this.console);

            if (this.storageSettings.values.dhcpMode !== 'Manual' || this.storageSettings.values.dhcpServer !== 'Enabled') {
                await removeServiceFile('vlan', this.nativeId!, this.console);
            }
            else {
                if (!this.storageSettings.values.addresses.length) {
                    this.console.warn('Address is required if DHCP Mode is Server.');
                    await removeServiceFile('vlan', this.nativeId!, this.console);
                }
                else {
                    const servers: string[] = this.storageSettings.values.dnsServers;
                    // insert -S between each server
                    const serverArgs = servers.map(server => ['-S', server]).flat();

                    const address: string = this.storageSettings.values.addresses[0];
                    const addressWithoutMask = address.split('/')[0];

                    let dhcpRanges: string[] = this.storageSettings.values.dhcpRanges;
                    if (!dhcpRanges?.length) {
                        dhcpRanges = [];
                        let start = 1;
                        const dotParts = addressWithoutMask.split('.');
                        if (dotParts.length === 4) {
                            const withoutEnd = addressWithoutMask.split('.').slice(0, 3).join('.');
                            const end = parseInt(dotParts[3]);
                            if (addressWithoutMask.endsWith('.1')) {
                                dhcpRanges.push(`${withoutEnd}.2,${withoutEnd}.220,12h`);
                            }
                            else {
                                dhcpRanges.push(`${withoutEnd}.1,${withoutEnd}.${end - 1},12h`);
                                dhcpRanges.push(`${withoutEnd}.${end + 1},${withoutEnd}.220,12h`);
                            }
                        }
                    }

                    if (!dhcpRanges?.length) {
                        this.console.warn('DHCP Range is required if DHCP Mode is Server.');
                        await removeServiceFile('vlan', this.nativeId!, this.console);
                    }
                    else if (this.storageSettings.values.dhcpServer === 'Enabled') {
                        // should persist between container recreation because it can not be regenerated like the hosts file
                        const hostsFile = `/etc/hosts.dnsmasq-${this.nativeId}`;
                        const dhcpHosts: string[] = [];
                        for (const nativeId of sdk.deviceManager.getNativeIds()) {
                            if (!nativeId?.startsWith('ar'))
                                continue;
                            const device = sdk.systemManager.getDeviceById(this.pluginId, nativeId);
                            if (device.providerId !== this.id)
                                continue;
                            const addressReservation = await this.getDevice(nativeId) as AddressReservation;
                            const { mac, ip, host } = addressReservation.storageSettings.values;
                            if (!mac || !ip || !host) {
                                addressReservation.console.warn('Mac, Address, and Host are required for address reservation.');
                                continue;
                            }

                            dhcpHosts.push(`${mac},${ip},${host},infinite`);
                        }

                        await fs.promises.writeFile(hostsFile, dhcpHosts.join('\n'));

                        const serviceFileContents = `
[Unit]
Description=DHCP for VLAN ${this.storageSettings.values.vlanId}
After=network.target

[Service]
User=root
Group=root
Type=simple
ExecStart=dnsmasq -d -R -i ${interfaceName} --except-interface=lo -z ${dhcpRanges.map(d => `--dhcp-range=${d}`).join(' ')} --dhcp-option=6,${addressWithoutMask} ${serverArgs.join(' ')} --dhcp-leasefile=${this.leaseFile} --dhcp-hostsfile=${hostsFile}
Restart=always
RestartSec=3
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target`;

                        await fs.promises.writeFile(serviceFile, serviceFileContents);
                        await systemctlDaemonReload(this.console);
                        await systemctlEnable('vlan', this.nativeId!, this.console);
                        await systemctlRestart('vlan', this.nativeId!, this.console);
                    }
                }
            }
        }
    }
}
