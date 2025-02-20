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
        addresses: {
            title: 'Addresses',
            type: 'string',
            description: 'The IP addresses of this network interface. The Addresses are ignored if the DHCP Mode is Client.',
            placeholder: '192.168.10.1/24',
            multiple: true,
            choices: [],
            combobox: true,
            defaultValue: [],
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
                // google
                '8.8.8.8',
                '8.8.4.4',
            ],
            defaultValue: [
            ],
        },
        internet: {
            title: 'Internet',
            description: 'The network interface that provides internet access to this network interface.',
            defaultValue: 'Disabled',
        },
        dhcpMode: {
            group: 'DHCP',
            title: 'DHCP Mode',
            description: 'The DHCP mode to use for this network interface.',
            choices: [
                'None',
                'Server',
                'Client',
            ],
            defaultValue: 'None',
        },
        dhcpRanges: {
            group: 'DHCP',
            title: 'DHCP Server Range',
            type: 'string',
            description: 'The DHCP range to use for this network interface. If not specified, a default range between will be used. E.g.: 192.168.10.10,192.168.10.200,12h',
            placeholder: '192.168.10.10,192.168.10.200,12h',
        },
        applyChanges: {
            title: 'Apply Changes',
            type: 'button',
            onPut: () => {
                this.networks.regenerateInterfaces();
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
                    'Disabled',
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

            if (this.storageSettings.values.dhcpMode !== 'Server') {
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
                            const end = parseInt( dotParts[3]);
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


        if (this.storageSettings.values.internet !== 'Disabled') {
            // create a chain for each vlan
            await runCommand('iptables', ['-t', 'nat', '-N', this.nativeId!], this.console);
            await runCommand('iptables', ['-N', this.nativeId!], this.console);
            // flush
            await runCommand('iptables', ['-t', 'nat', '-F', this.nativeId!], this.console);
            await runCommand('iptables', ['-F', this.nativeId!], this.console);
            // set up jump to chains
            await runCommand('iptables', ['-t', 'nat', '-A', 'POSTROUTING', '-o', this.storageSettings.values.internet, '-j', this.nativeId!], this.console);
            await runCommand('iptables', ['-A', 'FORWARD', '-j', this.nativeId!], this.console);
            // masquerade
            await runCommand('iptables', ['-t', 'nat', '-A', this.nativeId!, '-o', this.storageSettings.values.internet, '-j', 'MASQUERADE'], this.console);
            // setup forwarding
            await runCommand('iptables', ['-A', this.nativeId!, '-i', interfaceName, '-o', this.storageSettings.values.internet, '-j', 'ACCEPT'], this.console);
            await runCommand('iptables', ['-A', this.nativeId!, '-i', this.storageSettings.values.internet, '-o', interfaceName, '-m', 'state', '--state', 'RELATED,ESTABLISHED', '-j', 'ACCEPT'], this.console);
        }
    }
}
