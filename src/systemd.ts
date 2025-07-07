import * as fs from 'fs';
import * as path from 'path';
import { runCommand } from './cli';

async function runSystemctlCommand(command: string, args: string[], console: Console) {
    return runCommand('systemctl', [command, ...args], console);
}

export async function enumerateServiceFiles(suffix: string) {
    const serviceDir = '/etc/systemd/system';

    const files = fs.readdirSync(serviceDir);
    const serviceFiles = files.filter(file => file.startsWith(`scrypted-${suffix}`) && file.endsWith('.service'));

    return serviceFiles.map(file => path.join(serviceDir, file));
}

export function getServiceFileBasename(suffix: string, nativeId: string, extension = 'service') {
    return `scrypted-${suffix}-${nativeId}.${extension}`;
}

export function getServiceFile(suffix: string, nativeId: string, extension = 'service') {
    return `/etc/systemd/system/${getServiceFileBasename(suffix, nativeId, extension)}`;
}

export async function removeServiceFile(suffix: string, nativeId: string, console: Console, extension = 'service') {
    await systemctlStop(suffix, nativeId, console, extension);
    await systemctlDisable(suffix, nativeId, console, extension);
    await fs.promises.rm(getServiceFile(suffix, nativeId, extension), {
        force: true,
    });
    await systemctlDaemonReload(console);
}

export async function systemctlStop(suffix: string, nativeId: string, console: Console, extension = 'service') {
    await runSystemctlCommand('stop', [getServiceFileBasename(suffix, nativeId, extension)], console);
}

export async function systemctlStart(suffix: string, nativeId: string, console: Console, extension = 'service') {
    await runSystemctlCommand('start', [getServiceFileBasename(suffix, nativeId, extension)], console);
}

export async function systemctlRestart(suffix: string, nativeId: string, console: Console, extension = 'service') {
    await runSystemctlCommand('restart', [getServiceFileBasename(suffix, nativeId, extension)], console);
}

export async function systemctlDisable(suffix: string, nativeId: string, console: Console, extension = 'service') {
    await runSystemctlCommand('disable', [getServiceFileBasename(suffix, nativeId, extension)], console);
}

export async function systemctlEnable(suffix: string, nativeId: string, console: Console, extension = 'service') {
    await runSystemctlCommand('enable', [getServiceFileBasename(suffix, nativeId, extension)], console);
}

export async function systemctlDaemonReload(console: Console) {
    await runSystemctlCommand('daemon-reload', [], console);
}
