import fs from 'fs';
import { ScryptedDeviceBase, ScryptedNativeId, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import type { Networks } from "./networks";
import os from 'os';
import { getServiceFile, removeServiceFile, systemctlDaemonReload, systemctlDisable, systemctlEnable, systemctlRestart, systemctlStart, systemctlStop } from "./systemd";
import { ifdown, ifup } from "./ifupdown";
import { ChildProcess } from 'child_process';
import { logToConsoleAndWait, waitExit } from './cli';
import { getInterfaceName } from './interface-name';

export class Vlan extends ScryptedDeviceBase implements Settings {
    storageSettings = new StorageSettings(this, {
        parentInterface: {
            title: 'Parent Interface',
            type: 'string',
            async onGet() {
                return {
                    choices: Object.keys(os.networkInterfaces()),
                }
            },
        },
        vlanId: {
            title: 'VLAN ID',
            type: 'number',
            defaultValue: 1,
            description: 'The VLAN ID to use for this network interface. The default VLAN ID is 1.',
        },
        address: {
            title: 'Address',
            type: 'string',
            description: 'The IP address of this network interface.',
            placeholder: '192.168.10.1/24',
        },
        dnsServers: {
            title: 'DNS Servers',
            type: 'string',
            description: 'The DNS servers to use for this network interface.',
            multiple: true,
            combobox: true,
            choices: [],
            defaultValue: [
                '1.1.1.1',
                '1.0.0.1',
            ],
        },
        dhcpServer: {
            title: 'DHCP Server',
            type: 'boolean',
            description: 'Enable a DHCP server on this network interface.',
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

        if (!this.storageSettings.values.address || !this.storageSettings.values.parentInterface) {
            await ifdown(interfaceName, this.console)
            await removeServiceFile('vlan', this.nativeId!, this.console);
        }
        else {
            await ifup(interfaceName, this.console);

            if (!this.storageSettings.values.dhcpServer) {
                await removeServiceFile('vlan', this.nativeId!, this.console);
            }
            else {
                const servers: string[] = this.storageSettings.values.dnsServers;
                // insert -S between each server
                const serverArgs = servers.map(server => ['-S', server]).flat();

                const address = this.storageSettings.values.address;
                const addressWithoutMask = address.split('/')[0];

                const serviceFileContents = `
    [Unit]
    Description=DHCP for VLAN ${this.storageSettings.values.vlanId}
    After=network.target
    
    [Service]
    User=root
    Group=root
    Type=simple
    ExecStart=dnsmasq -d -R -i ${interfaceName} -z --dhcp-range=192.168.10.10,192.168.10.200,12h --dhcp-option=6,${addressWithoutMask} ${serverArgs.join(' ')}
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
