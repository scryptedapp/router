import { ScryptedDeviceBase, ScryptedNativeId, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import fs from 'fs';
import os from 'os';
import { ifdown } from "./ifupdown";
import { getInterfaceName } from './interface-name';
import type { Networks } from "./networks";
import { getServiceFile, removeServiceFile, systemctlDaemonReload, systemctlEnable, systemctlRestart } from "./systemd";
import { runCommand } from "./cli";

export class Vlan extends ScryptedDeviceBase implements Settings {
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
    }

    getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async initializeNetworkInterface() {
        const interfaceName = getInterfaceName(this.storageSettings.values.parentInterface, this.storageSettings.values.vlanId);
        const serviceFile = getServiceFile('vlan', this.nativeId!);

        if (!this.storageSettings.values.parentInterface || !this.storageSettings.values.parentInterface) {
            await ifdown(interfaceName, this.console)
            await removeServiceFile('vlan', this.nativeId!, this.console);
        }
        else {
            // await ifup(interfaceName, this.console);

            if (this.storageSettings.values.dhcpMode !== 'Manual + DHCP Server') {
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
                    else {
                        // dnsmasq -d -i eth1.10:svdff7 -z --dhcp-range=192.168.10.100,192.168.10.200,12h --dhcp-option=6,192.168.10.1

                        const serviceFileContents = `
[Unit]
Description=DHCP for VLAN ${this.storageSettings.values.vlanId}
After=network.target

[Service]
User=root
Group=root
Type=simple
ExecStart=dnsmasq -d -R -i ${interfaceName} -z ${dhcpRanges.map(d => `--dhcp-range=${d}`).join(' ')} --dhcp-option=6,${addressWithoutMask} ${serverArgs.join(' ')}
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

        // iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
        // iptables -A FORWARD -i eth1.10 -o eth0 -j ACCEPT
        // iptables -A FORWARD -i eth0 -o eth1.10 -m state --state RELATED,ESTABLISHED -j ACCEPT

        if (this.storageSettings.values.gatewayMode !== 'Local Interface') {
            if (!this.storageSettings.values.internet) {
                this.console.warn('Local Interface is is unconfigured.');
            }
            else {
                let [, internetVlanId] = this.storageSettings.values.internet.split('.');
                internetVlanId ||= 1;

                for (const ipvtables of ['iptables', 'ip6tables']) {
                    // create a chain for each vlan
                    await runCommand(ipvtables, ['-t', 'nat', '-N', this.nativeId!], this.console);
                    await runCommand(ipvtables, ['-N', this.nativeId!], this.console);

                    // flush the chain
                    await runCommand(ipvtables, ['-t', 'nat', '-F', this.nativeId!], this.console);
                    await runCommand(ipvtables, ['-F', this.nativeId!], this.console);

                    // no need to do any ip6tables if the vlan matches.
                    // routing is necessary on vlan mismatch
                    if (ipvtables === 'ip6tables' && this.storageSettings.values.vlanId === internetVlanId)
                        continue;

                    // delete jump chains
                    await runCommand(ipvtables, ['-t', 'nat', '-D', 'POSTROUTING', '-o', this.storageSettings.values.internet, '-j', this.nativeId!], this.console);
                    await runCommand(ipvtables, ['-D', 'FORWARD', '-j', this.nativeId!], this.console);

                    // set up the jump chains
                    await runCommand(ipvtables, ['-t', 'nat', '-A', 'POSTROUTING', '-o', this.storageSettings.values.internet, '-j', this.nativeId!], this.console);
                    await runCommand(ipvtables, ['-A', 'FORWARD', '-j', this.nativeId!], this.console);

                    // masquerade
                    await runCommand(ipvtables, ['-t', 'nat', '-A', this.nativeId!, '-o', this.storageSettings.values.internet, '-j', 'MASQUERADE'], this.console);

                    // setup forwarding
                    await runCommand(ipvtables, ['-A', this.nativeId!, '-i', interfaceName, '-o', this.storageSettings.values.internet, '-j', 'ACCEPT'], this.console);
                    await runCommand(ipvtables, ['-A', this.nativeId!, '-i', this.storageSettings.values.internet, '-o', interfaceName, '-m', 'state', '--state', 'RELATED,ESTABLISHED', '-j', 'ACCEPT'], this.console);

                }
            }
        }
    }
}
