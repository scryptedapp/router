import net from 'net';
import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting } from "@scrypted/sdk";
import { Vlan } from "./vlan";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import crypto from 'crypto';
import fs from 'fs';
import { getInterfaceName } from "./interface-name";
import yaml from 'yaml';
import { EthernetInterface, NetplanConfig, Route, RoutingPolicy, VlanInterface } from "./netplan";
import { runCommand } from "./cli";
import os from 'os';
import { generateDhClientHooks } from './dhclient';
import { generateNftablesConf } from './nftables';
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

        this.regenerateInterfaces(this.console);
    }

    async regenerateInterfaces(console: Console) {
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


        let tablesStart = 100;
        const tableMaps = new Map<string, number>();

        const ipv4Default = '0.0.0.0/0';
        const ipv6Default = '::/0';

        const dhclientPairs: { wanInterface: string; fromIp: string; table: number }[] = [];
        const nftablesPairs: {
            ipVersion: 'ip' | 'ip6',
            wanInterface: string;
            lanInterface: string
        }[] = [];

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

            let { addresses, dhcpMode, dnsServers, internet, gateway4, gateway6 } = vlan.storageSettings.values;
            if (vlan.storageSettings.values.gatewayMode !== 'Manual') {
                internet = undefined;
                gateway4 = undefined;
                gateway6 = undefined;
            }

            const dhcpClient = dhcpMode === 'Auto';
            if (!addresses.length && !dhcpClient) {
                vlan.console.warn('Address is required if DHCP Mode is not Client.');
                continue;
            }


            const dhcp4 = dhcpClient && !!vlan.storageSettings.values.dhcp4;
            const dhcp6 = dhcpClient && !!vlan.storageSettings.values.dhcp6;
            const acceptRa = dhcpClient && !!vlan.storageSettings.values.acceptRa;

            const nameservers = dnsServers?.length ? {
                addresses: dnsServers,
            } : undefined;

            const interfaceName = getInterfaceName(parentInterface, vlanId);

            let table = tableMaps.get(interfaceName);
            if (!table) {
                table = tablesStart++;
                tableMaps.set(interfaceName, table);
            }

            const defaultRoute: Route = {
                to: ipv4Default,
                table,
                type: 'blackhole',
            };

            const routes: Route[] = [
                defaultRoute,
            ];
            const routingPolicy: RoutingPolicy[] = [];

            for (const address of addresses) {
                routes.push({
                    to: address,
                    scope: 'link',
                    table,
                } satisfies Route);
            }

            if (dhcpClient) {
                (addresses as string[]).splice(0, addresses.length);
            }
            else {
                for (const address of addresses as string[]) {
                    const [ip] = address.split('/');
                    routingPolicy.push({
                        from: ip,
                        table,
                        priority: 1,
                    } satisfies RoutingPolicy);
                    routingPolicy.push({
                        to: ip,
                        table,
                        priority: 1,
                    } satisfies RoutingPolicy);
                }

                if (internet !== 'Disabled') {
                    // don't fail hard if this is misconfigured.
                    if (gateway4 || gateway6) {
                        vlan.console.warn('Internet is enabled, but a gateway was provided. Preferring gateway.');
                    }
                    else {
                        const internetVlan = [...this.vlans.values()].find(v => getInterfaceName(v.storageSettings.values.parentInterface, v.storageSettings.values.vlanId) === internet);
                        if (!internetVlan) {
                            this.console.warn(`Internet interface ${internet} not found or is not managed directly.`);
                        }
                        else {
                            let internetTable = tableMaps.get(internet);
                            if (!internetTable) {
                                internetTable = tablesStart++;
                                tableMaps.set(internet, internetTable);
                            }

                            // remove the default route blackhole
                            routes.splice(routes.indexOf(defaultRoute), 1);

                            // add a new routing policy specifically for this internet
                            for (const address of addresses as string[]) {
                                const [ip] = address.split('/');
                                routingPolicy.push({
                                    from: vlan.storageSettings.values.dhcpServer === 'Enabled' ? address : ip,
                                    table: internetTable,
                                    priority: 2,
                                } satisfies RoutingPolicy);
                            }

                            if (internetVlan.storageSettings.values.dhcpMode !== 'Auto') {
                                for (const address of addresses) {
                                    const [ip] = address.split('/');
                                    if (net.isIPv4(ip) && internetVlan.storageSettings.values.gateway4) {
                                        routes.push(
                                            {
                                                from: ip,
                                                to: ipv4Default,
                                                via: internetVlan.storageSettings.values.gateway4,
                                                table,
                                            }
                                        )
                                    }
                                    else if (net.isIPv6(ip) && internetVlan.storageSettings.values.gateway6) {
                                        routes.push(
                                            {
                                                from: ip,
                                                to: ipv6Default,
                                                via: internetVlan.storageSettings.values.gateway6,
                                                table,
                                            }
                                        )
                                    }
                                }
                            }
                            else {
                                const wanInterface = getInterfaceName(internetVlan.storageSettings.values.parentInterface, internetVlan.storageSettings.values.vlanId);

                                nftablesPairs.push({
                                    ipVersion: 'ip',
                                    wanInterface,
                                    lanInterface: interfaceName
                                });

                                // no need to do any ip6tables if the vlan matches.
                                // routing is necessary on vlan mismatch
                                if (vlan.storageSettings.values.vlanId !== internetVlan.storageSettings.values.vlanId) {
                                    nftablesPairs.push({
                                        ipVersion: 'ip6',
                                        wanInterface,
                                        lanInterface: interfaceName
                                    });
                                }

                                // need to hook dhclient and set the route manually.
                                // one option is to call this plugin, but the better option is probably to
                                // set the route table manually.
                                for (const address of addresses) {
                                    const [fromIp] = address.split('/');
                                    dhclientPairs.push({
                                        wanInterface,
                                        fromIp,
                                        table: internetTable,
                                    } satisfies { wanInterface: string; fromIp: string; table: number });
                                }
                            }
                        }
                    }
                }

                if (gateway4 || gateway6) {
                    // remove the default route blackhole
                    routes.splice(routes.indexOf(defaultRoute), 1);

                    for (const address of addresses) {
                        const [ip] = address.split('/');
                        if (net.isIPv4(ip) && gateway4) {
                            routes.push(
                                {
                                    from: ip,
                                    to: ipv4Default,
                                    via: gateway4,
                                    table,
                                }
                            )
                        }
                        else if (net.isIPv6(ip) && gateway6) {
                            routes.push(
                                {
                                    from: ip,
                                    to: ipv6Default,
                                    via: gateway6,
                                    table,
                                }
                            )
                        }
                    }
                }
            }

            bringup.add(vlan);

            let iface: EthernetInterface | VlanInterface;

            if (vlanId === 1) {
                iface = netplan.network.ethernets![parentInterface] = {}
            }
            else {
                needParentInterfaces.add(parentInterface);
                iface = netplan.network.vlans![interfaceName] = {
                    link: parentInterface,
                    id: vlanId,
                }
            }

            Object.assign(iface, {
                addresses: addresses.length ? addresses : undefined,
                nameservers,
                optional: true,
                dhcp4,
                dhcp6,
                "accept-ra": acceptRa,
                routes,
                "routing-policy": routingPolicy,
                // don't add to default route table, will add to custom table.
                "dhcp4-overrides": {
                    "use-routes": false,
                    "use-domains": false,
                },
                "dhcp6-overrides": {
                    "use-routes": false,
                    "use-domains": false,
                },
            } satisfies EthernetInterface | VlanInterface);
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
        await runCommand('netplan', ['apply'], console);

        for (const vlan of bringup) {
            await vlan.initializeNetworkInterface();
        }

        const dhClientScript = generateDhClientHooks(dhclientPairs);
        await fs.promises.writeFile(`/etc/dhcp/dhclient-exit-hooks.d/scrypted`, dhClientScript, {
            mode: 0o755,
        });
        await runCommand('dhclient', [], console);

        const nftablesConf = generateNftablesConf(nftablesPairs);
        await fs.promises.writeFile(`/etc/nftables.d/scrypted.conf`, nftablesConf, {
            mode: 0o600,
        });
        await runCommand('nft', ['-f', '/etc/nftables.d/scrypted.conf'], console);
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
        if (!vlanId)
            vlanId = 1;
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
