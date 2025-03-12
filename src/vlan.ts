import sdk, { AdoptDevice, DeviceCreator, DeviceCreatorSettings, DeviceDiscovery, DeviceProvider, DiscoveredDevice, OnOff, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, ScryptedSystemDevice, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { AddressReservation, getAddressReservationSettings } from "./address-reservation";
import { parseCidrIp } from './cidr';
import { fakeLoopbackv4, fakeLoopbackv6 } from "./fake-loopback";
import { getInterfaceName } from './interface-name';
import type { Networks } from "./networks";
import { getPortForwardSettings, PortForward } from "./port-forward";
import { getServiceFile, removeServiceFile, systemctlDaemonReload, systemctlDisable, systemctlEnable, systemctlRestart, systemctlStop } from "./systemd";
import { toVendor } from '@network-utils/vendor-lookup'

function findInterfaceAddress(name: string) {
    const interfaces = os.networkInterfaces();
    for (const [key, value] of Object.entries(interfaces)) {
        if (key === name) {
            return value?.[0]?.address;
        }
    }
    return undefined;

}

export class Vlan extends ScryptedDeviceBase implements Settings, DeviceProvider, DeviceCreator, ScryptedSystemDevice, DeviceDiscovery, OnOff {
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

        addressMode: {
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
            radioGroups: ['Address Configuration:Manual'],
            type: 'string',
            description: 'IPv4 or IPv6 address of this network interface.',
            placeholder: 'E.g.: 192.168.10.1/24, 2001:abc:def::de/64',
            multiple: true,
            defaultValue: [],
        },

        gatewayMode: {
            title: 'Internet Gateway',
            radioGroups: ['Address Configuration:Manual'],
            type: 'radiobutton',
            choices: ['Internet', 'Network Interface', 'Manual', 'Disabled'],
            defaultValue: 'Disabled',
            description: 'The connection to use as the internet gateway.',
        },
        internet: {
            title: 'Internet',
            radioGroups: ['Internet Gateway:Internet'],
            description: 'Select an existing configured internet connection.',
            type: 'device',
            deviceFilter: ({type, ScryptedDeviceType}) => {
                return type === ScryptedDeviceType.Internet;
            },
        },
        networkInterfaceInternet: {
            title: 'Network Interface',
            radioGroups: ['Internet Gateway:Network Interface'],
            description: 'Local network interface provides internet connectivity.',
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
            radioGroups: ['Address Configuration:Auto'],
            type: 'boolean',
            description: 'Enable DHCPv4 for this network interface.',
            defaultValue: true,
        },
        dhcp6: {
            title: 'DHCPv6',
            radioGroups: ['Address Configuration:Auto'],
            type: 'boolean',
            description: 'Enable DHCPv6 for this network interface.',
            defaultValue: true,
        },
        acceptRa: {
            title: 'Accept Router Advertisements',
            radioGroups: ['Address Configuration:Auto'],
            type: 'boolean',
            description: 'Accept Router Advertisements for this network interface.',
            defaultValue: true,
        },

        dhcpServer: {
            title: 'DHCP Server',
            group: 'DHCP Server',
            type: 'radiobutton',
            choices: ['Enabled', 'Disabled'],
            description: 'Enable DHCP server for this network interface.',
            defaultValue: false,
        },
        dhcpRanges: {
            title: 'DHCP Server Ranges',
            group: 'DHCP Server',
            radioGroups: ['DHCP Server:Enabled'],
            type: 'string',
            description: 'The DHCP range to use for this network interface. If not specified, a default range between will be used. E.g.: 192.168.10.10,192.168.10.200,12h',
            placeholder: '192.168.10.10,192.168.10.200,12h',
            multiple: true,
        },
        enableRouterAdvertisements: {
            title: 'Enable Router Advertisements',
            group: 'DHCP Server',
            radioGroups: ['DHCP Server:Enabled'],
            type: 'boolean',
            description: 'Enable Router Advertisements for this network interface.',
            defaultValue: true,
        },
        dhcpGateway: {
            title: 'DHCP Gateway',
            group: 'DHCP Server',
            radioGroups: ['DHCP Server:Enabled'],
            type: 'string',
            description: 'Advanced: The DHCP gateway to use for this network interface. If not specified, this interface\'s address will be used.',
        },

        dnsConfiguration: {
            title: 'DNS Configuration',
            type: 'radiobutton',
            description: 'Automatically configure this network\'s DNS settings using the internet connection.',
            choices: ['Auto', 'Manual'],
            defaultValue: 'Auto',
            radioGroups: [
                'Address Configuration:Auto',
                'Internet Gateway:Network Interface',
            ]
        },
        dnsServers: {
            title: 'DNS Servers',
            type: 'string',
            description: 'The DNS servers to use for this network interface.',
            radioGroups: [
                'Address Configuration:Auto',
                'Internet Gateway:Disabled',
                'Internet Gateway:Manual',
                'DNS Configuration:Manual'
            ],
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
        dnsSearchDomains: {
            title: 'DNS Search Domains',
            type: 'string',
            description: 'The DNS search domains to use for this network interface.',
            multiple: true,
            combobox: true,
            choices: [
                'local',
                'localdomain',
            ],
            defaultValue: [
                'localdomain',
            ]
        },

        applyChanges: {
            title: 'Apply Changes',
            type: 'button',
            onPut: () => {
                this.networks.regenerateInterfaces(this.console);
            },
            console: true,
        },

        httpsServerPort: {
            type: 'number',
            hide: true,
        },
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

        this.storageSettings.settings.networkInterfaceInternet.onGet = async () => {
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

        if (typeof this.on !== 'boolean')
            this.on = true;
    }

    get interfaceName() {
        return getInterfaceName(this.storageSettings.values.parentInterface, this.storageSettings.values.vlanId);
    }

    async turnOn(): Promise<void> {
        this.on = true;
    }

    async turnOff(): Promise<void> {
        this.on = false;
    }

    async getDevice(nativeId: ScryptedNativeId) {
        if (nativeId?.startsWith('pf'))
            return new PortForward(this, nativeId);
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
            let name = parts[3];
            if (name === '*')
                name = toVendor(mac) || mac;
            devices.push({
                name,
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
            const portForward = new PortForward(this, nativeId);
            portForward.storageSettings.values.protocol = settings.protocol;
            portForward.storageSettings.values.srcPort = settings.srcPort;
            portForward.storageSettings.values.dstIp = settings.dstIp;
            portForward.storageSettings.values.dstPort = settings.dstPort;

            portForward.storageSettings.values.srcDomain = settings.srcDomain;
            portForward.storageSettings.values.dstAddress = settings.dstAddress;
            portForward.storageSettings.values.dnsSetup = settings.dnsSetup;
            portForward.storageSettings.values.cloudflareDns = settings.cloudflareDns;
            portForward.storageSettings.values.caddyfile = settings.caddyfile;

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
            ScryptedInterface.OnOff,
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
            // this.storageSettings.settings.gatewayMode.type = 'radiopanel';
            this.storageSettings.settings.gatewayMode.hide = true;
            this.storageSettings.settings.networkInterfaceInternet.hide = true;
            this.storageSettings.settings.internet.hide = true;
            this.storageSettings.settings.gateway4.radioGroups = ['Address Configuration:Manual'];
            this.storageSettings.settings.gateway6.radioGroups = ['Address Configuration:Manual'];
            this.storageSettings.settings.dhcpServer.hide = true;
            this.storageSettings.settings.dhcpRanges.hide = true;
            this.storageSettings.settings.dhcpGateway.hide = true;
            this.storageSettings.settings.enableRouterAdvertisements.hide = true;
            this.storageSettings.settings.dnsConfiguration.radioGroups = [
                'Address Configuration:Auto',
            ];
            this.storageSettings.settings.dnsSearchDomains.hide = true;
        }
    }

    async getLocalNetworks() {
        const interfaceName = getInterfaceName(this.storageSettings.values.parentInterface, this.storageSettings.values.vlanId);
        const vlans: Vlan[] = [];
        for (const vlan of this.networks.vlans.values()) {
            if (vlan.storageSettings.values.gatewayMode === 'Network Interface' && vlan.storageSettings.values.networkInterfaceInternet === interfaceName) {
                vlans.push(vlan);
            }
            else if (vlan.storageSettings.values.gatewayMode === 'Internet' && vlan.storageSettings.values.networkInterfaceInternet === interfaceName) {
                vlans.push(vlan);
            }
        }
        return vlans;
    }

    async getPortForwards() {
        const ret: PortForward[] = [];
        for (const nativeId of sdk.deviceManager.getNativeIds()) {
            if (!nativeId?.startsWith('pf'))
                continue;
            const device = sdk.systemManager.getDeviceById(this.pluginId, nativeId);
            if (device.providerId !== this.id)
                continue;
            const portforward = await this.getDevice(nativeId) as PortForward;
            ret.push(portforward);
        }
        return ret;
    }

    get ips() {
        return (this.storageSettings.values.addresses as string[]).map(cidr => parseCidrIp(cidr));
    }

    get ipv4Address() {
        return this.ips.find(ip => net.isIPv4(ip));
    }

    get ipv6Address() {
        return this.ips.find(ip => net.isIPv6(ip));
    }

    async setupCaddy() {
        if (this.providedType !== ScryptedDeviceType.Internet) {
            await removeServiceFile('caddy', this.nativeId!, this.console);
            return;
        }

        const localAddresses: string[] = [];
        const localNetworks = await this.getLocalNetworks();
        const nameMap = new Map<string, string>();

        for (const localNetwork of localNetworks) {
            if (localNetwork.storageSettings.values.addressMode === 'Manual') {
                const ipv4 = localNetwork.ipv4Address;
                if (!ipv4)
                    continue;
                localAddresses.push(ipv4);

                const discovered = await (localNetwork.discoverDevices().catch(() => { }));
                if (discovered) {
                    for (const d of discovered) {
                        nameMap.set(d.name?.toLowerCase(), ipv4);
                    }
                }
            }
        }

        let caddyfile = '';
        const portforwards = await this.getPortForwards();
        for (const portforward of portforwards) {
            const { dstAddress, srcDomain, protocol, dnsSetup, cloudflareDns, caddyfile: caddyfileBlock } = portforward.storageSettings.values;
            if (!protocol.startsWith('http'))
                continue;

            let dstUrl: URL | undefined;
            try {
                dstUrl = new URL(dstAddress);
            }
            catch (e) {
                if (caddyfileBlock) {
                    portforward.console.log('Destination Address is unset, using provided Caddyfile.');
                }
                else {
                    portforward.console.warn('Invalid Destination Address.');
                    continue;
                }
            }

            if (!srcDomain) {
                portforward.console.warn('Domain is required for port forward.');
                continue;
            }

            let dns = '';
            switch (dnsSetup) {
                case 'Cloudflare':
                    if (!cloudflareDns) {
                        portforward.console.warn('Cloudflare DNS is required for Cloudflare DNS setup.');
                        continue;
                    }
                    dns = `dns cloudflare ${cloudflareDns}`;
                    break;
            }

            const { httpsServerPort } = this.storageSettings.values;

            let reverseProxyOrigin = '';
            if (dstUrl) {
                reverseProxyOrigin = `
    reverse_proxy /* ${dstUrl.origin} {
        transport http {
                resolvers ${nameMap.get(dstUrl.hostname.toLowerCase()) || localAddresses.join(' ')}
        }
    }
`;
            }

            caddyfile += `
http://${srcDomain}:${httpsServerPort + 1} {
    bind ${parseCidrIp(fakeLoopbackv4)}
    bind ${parseCidrIp(fakeLoopbackv6)}

    ${caddyfileBlock}

    ${reverseProxyOrigin}
}

https://${srcDomain}:${httpsServerPort} {
    bind ${parseCidrIp(fakeLoopbackv4)}
    bind ${parseCidrIp(fakeLoopbackv6)}

    ${caddyfileBlock}

    ${reverseProxyOrigin}

    tls {
            ${dns}
    }
}
`;
        }


        if (!caddyfile) {
            await removeServiceFile('caddy', this.nativeId!, this.console);
            return;
        }

        const caddyDataDir = path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, 'caddy', this.nativeId!);
        caddyfile = `
{
    storage file_system {
        root ${caddyDataDir}
    }
}

${caddyfile}
`;

        const caddyfilePath = path.join('/etc', `Caddyfile.${this.nativeId}`);

        const serviceFileContents = `
# caddy.service
#
# For using Caddy with a config file.
#
# Make sure the ExecStart and ExecReload commands are correct
# for your installation.
#
# See https://caddyserver.com/docs/install for instructions.
#
# WARNING: This service does not use the --resume flag, so if you
# use the API to make changes, they will be overwritten by the
# Caddyfile next time the service is restarted. If you intend to
# use Caddy's API to configure it, add the --resume flag to the
# \`caddy run\` command or use the caddy-api.service file instead.

[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
ExecStart=/usr/local/bin/caddy run -c ${caddyfilePath} 
ExecReload=/usr/local/bin/caddy run --force -c ${caddyfilePath}
WorkingDirectory=/root
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
#Environment=CADDY_ADMIN=10.0.0.1:2019
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
`;

        await fs.promises.writeFile(caddyfilePath, caddyfile);
        await fs.promises.writeFile(getServiceFile('caddy', this.nativeId!), serviceFileContents);

        await systemctlDaemonReload(this.console);
        await systemctlEnable('caddy', this.nativeId!, this.console);
        await systemctlRestart('caddy', this.nativeId!, this.console);
    }

    async initializeNetworkInterface() {
        const interfaceName = getInterfaceName(this.storageSettings.values.parentInterface, this.storageSettings.values.vlanId);
        const serviceFile = getServiceFile('vlan', this.nativeId!);

        if (!this.storageSettings.values.parentInterface || !this.storageSettings.values.parentInterface) {
            // invalid config
            await removeServiceFile('vlan', this.nativeId!, this.console);
            await removeServiceFile('caddy', this.nativeId!, this.console);
            return;
        }

        if (this.storageSettings.values.addressMode === 'Auto' || this.storageSettings.values.dhcpServer !== 'Enabled') {
            // no dhcp server in use
            await removeServiceFile('vlan', this.nativeId!, this.console);
            await this.setupCaddy();
            return;
        }

        if (!this.storageSettings.values.addresses.length) {
            // invalid config
            this.console.warn('Address is required if DHCP Mode is Server.');
            await removeServiceFile('vlan', this.nativeId!, this.console);
            await removeServiceFile('caddy', this.nativeId!, this.console);
            return;
        }

        const servers: string[] = this.storageSettings.values.dnsServers;
        // insert -S between each server
        const serverArgs = servers.map(server => ['-S', server]).flat();

        const address: string = this.storageSettings.values.addresses[0];
        const addressWithoutMask = parseCidrIp(address);

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
            // invalid config but recoverable
            this.console.warn('DHCP Range is required if DHCP Mode is Server.');
            await removeServiceFile('vlan', this.nativeId!, this.console);
            await this.setupCaddy();
            return;
        }

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

        const dhcpGateway = this.storageSettings.values.dhcpGateway || addressWithoutMask;
        const dnsSearchDomains = this.storageSettings.values.dnsSearchDomains.length ? `--dhcp-option=119,${this.storageSettings.values.dnsSearchDomains.join(',')}` : '';
        const enableRouterAdvertisements = this.storageSettings.values.enableRouterAdvertisements ? '--enable-ra' : '';

        const serviceFileContents = `
[Unit]
Description=DHCP for VLAN ${this.storageSettings.values.vlanId}
After=network.target

[Service]
User=root
Group=root
Type=simple
ExecStart=dnsmasq -d -R -h ${enableRouterAdvertisements} --host-record=${os.hostname()},${addressWithoutMask} -i ${interfaceName} --except-interface=lo -z ${dhcpRanges.map(d => `--dhcp-range=${d}`).join(' ')} ${dnsSearchDomains} --dhcp-option=3,${dhcpGateway} --dhcp-option=6,${addressWithoutMask} ${serverArgs.join(' ')} --dhcp-leasefile=${this.leaseFile} --dhcp-hostsfile=${hostsFile}
Restart=always
RestartSec=3
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target`;

        await fs.promises.writeFile(serviceFile, serviceFileContents);

        await this.setupCaddy();

        await systemctlDaemonReload(this.console);
        await systemctlEnable('vlan', this.nativeId!, this.console);
        await systemctlRestart('vlan', this.nativeId!, this.console);
    }
}
