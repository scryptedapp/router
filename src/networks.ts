import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { runCommand } from "./cli";
import { createDhcpWatcher } from './dchp-watcher';
import { getInterfaceName } from "./interface-name";
import { EthernetInterface, NetplanConfig, Route, RoutingPolicy, VlanInterface } from "./netplan";
import { addPortForward, addWanGateway, flushChains } from './nftables';
import { PortForward } from './port-forward';
import { Vlan } from "./vlan";
export class Networks extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator, Settings {
    vlans = new Map<string, Vlan>();
    storageSettings = new StorageSettings(this, {
        defaultInternet: {
            title: 'Default Internet',
            type: 'device',
        }
    });

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


        this.storageSettings.settings.defaultInternet.onGet = async () => {
            const choices: string[] = [];
            for (const nativeId of sdk.deviceManager.getNativeIds()) {
                if (nativeId?.startsWith('sv')) {
                    const device = await this.getDevice(nativeId) as Vlan;
                    if (device.providedType === ScryptedDeviceType.Internet) {
                        choices.push(device.id);
                    }
                }
            }

            return {
                deviceFilter: `${JSON.stringify(choices)}.includes(id)`,
            }
        }
    }

    getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
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
        const nftables = new Set<string>();
        flushChains(nftables);

        const ensureTable = (interfaceName: string) => {
            let table = tableMaps.get(interfaceName);
            if (!table) {
                table = tablesStart++;
                tableMaps.set(interfaceName, table);
            }
            return table;
        }

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

            let { addresses, addressMode, dnsServers, internet, gateway4, gateway6, gatewayMode } = vlan.storageSettings.values;
            if (gatewayMode !== 'Manual') {
                gateway4 = undefined;
                gateway6 = undefined;
            }

            const dhcpClient = addressMode === 'Auto';
            if (!addresses.length && !dhcpClient)
                vlan.console.warn('Address is unconfigured.');

            const dhcp4 = dhcpClient && !!vlan.storageSettings.values.dhcp4;
            const dhcp6 = dhcpClient && !!vlan.storageSettings.values.dhcp6;
            const acceptRa = dhcpClient && !!vlan.storageSettings.values.acceptRa;

            const nameservers = dnsServers?.length ? {
                addresses: dnsServers,
            } : undefined;

            const interfaceName = getInterfaceName(parentInterface, vlanId);

            const table = ensureTable(interfaceName);

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

                if (gatewayMode !== 'Disabled') {
                    if (gateway4 || gateway6) {
                        // fall through to use this instead.
                    }
                    else {
                        const internetVlan = [...this.vlans.values()].find(v => getInterfaceName(v.storageSettings.values.parentInterface, v.storageSettings.values.vlanId) === internet);
                        if (!internetVlan) {
                            this.console.warn(`Internet interface ${internet} not found or is not managed directly.`);
                        }
                        else {
                            const internetTable = ensureTable(internet);

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

                            // iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
                            // iptables -A FORWARD -i eth1.10 -o eth0 -j ACCEPT
                            // iptables -A FORWARD -i eth0 -o eth1.10 -m state --state RELATED,ESTABLISHED -j ACCEPT

                            const wanInterface = getInterfaceName(internetVlan.storageSettings.values.parentInterface, internetVlan.storageSettings.values.vlanId);
                            addWanGateway(nftables, 'ip', wanInterface, interfaceName);

                            // no need to do any ip6tables if the vlan matches.
                            // routing is necessary on vlan mismatch
                            if (vlan.storageSettings.values.vlanId !== internetVlan.storageSettings.values.vlanId) {
                                addWanGateway(nftables, 'ip6', wanInterface, interfaceName);
                            }

                            if (internetVlan.storageSettings.values.addressMode !== 'Auto') {
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
                            );

                            if (this.storageSettings.values.defaultInternet.id === vlan.id) {
                                routes.push(
                                    {
                                        to: ipv4Default,
                                        via: gateway4,
                                    }
                                );
                            }
                        }
                        else if (net.isIPv6(ip) && gateway6) {
                            routes.push(
                                {
                                    from: ip,
                                    to: ipv6Default,
                                    via: gateway6,
                                    table,
                                }
                            );

                            if (this.storageSettings.values.defaultInternet.id === vlan.id) {
                                routes.push(
                                    {
                                        to: ipv6Default,
                                        via: gateway6,
                                    }
                                );
                            }
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

            for (const nativeId of sdk.deviceManager.getNativeIds()) {
                if (!nativeId?.startsWith('pf'))
                    continue;
                const device = sdk.systemManager.getDeviceById(this.pluginId, nativeId);
                if (device.providerId !== vlan.id)
                    continue;
                const portforward = await vlan.getDevice(nativeId) as PortForward;
                const { srcPort, dstIp, dstPort, protocol } = portforward.storageSettings.values;
                if (!srcPort || !dstIp || !dstPort || !protocol) {
                    portforward.console.warn('Source Port, Destination IP, and Destination Port are required for port forward.');
                    continue;
                }

                const lanInterfaces = new Set<string>();
                for (const vlan of this.vlans.values()) {
                    if (vlan.storageSettings.values.gatewayMode === 'Local Interface' && vlan.storageSettings.values.internet === interfaceName) {
                        const vlanInterfaceName = getInterfaceName(vlan.storageSettings.values.parentInterface, vlan.storageSettings.values.vlanId);
                        lanInterfaces.add(vlanInterfaceName);

                        // need this route policy for hairpinning.
                        if (vlan.storageSettings.values.addressMode === 'Manual') {
                            const vlanTable = ensureTable(vlanInterfaceName);
                            for (const address of vlan.storageSettings.values.addresses) {
                                routingPolicy.push({
                                    from: address,
                                    table: vlanTable,
                                    priority: 1,
                                } satisfies RoutingPolicy);
                            }
                        }
                    }
                }

                const ipv4Addresses = (addresses as string[] || []).map(address => address.split('/')[0]).filter(address => net.isIPv4(address));
                addPortForward(nftables, 'ip', interfaceName, ipv4Addresses, lanInterfaces, protocol, srcPort, dstIp, dstPort);
            }
        }

        for (const parentInterface of needParentInterfaces) {
            if (netplan.network.ethernets![parentInterface])
                continue;
            netplan.network.ethernets![parentInterface] = {
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

        const dhcpWatchScript = createDhcpWatcher(dhclientPairs);
        await fs.promises.writeFile('/etc/dhcp/scrypted-dhcp-watcher', dhcpWatchScript, {
            mode: 0o755,
        });
        await runCommand('systemctl', ['restart', 'scrypted-dhcp-watcher'], console);

        const nftablesConf = [...nftables].join('\n');
        await fs.promises.writeFile(`/etc/nftables.d/02-scrypted.conf`, nftablesConf, {
            mode: 0o600,
        });
        await runCommand('nft', ['-f', '/etc/nftables.d/02-scrypted.conf'], console);
    }

    get netplanFile() {
        return path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, `netplan-scrypted.yaml`);
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
            networkType: {
                title: 'Network Type',
                type: 'string',
                choices: ['Network', 'Bridge', 'Internet'],
                defaultValue: 'Network',
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

        let type = 'Network';
        if (settings.networkType === 'Bridge')
            type = 'Bridge';
        else if (settings.networkType === 'Internet')
            type = 'Internet';

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
                ScryptedInterface.DeviceProvider,
                ScryptedInterface.DeviceCreator,
                ScryptedInterface.Settings,
                ScryptedInterface.ScryptedSystemDevice,
            ],
            type: type as ScryptedDeviceType,
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
