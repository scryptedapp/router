import {once} from 'events';
import * as fs from 'fs';
import * as path from 'path';
import child_process, { ChildProcess } from 'child_process';
import { logToConsoleAndWait, runCommand } from './cli';

async function runSystemctlCommand(command: string, args: string[], console: Console) {
    return runCommand('systemctl', [command, ...args], console);
}

export async function enumerateServiceFiles(suffix: string) {
    const serviceDir = '/etc/systemd/system';

    const files = fs.readdirSync(serviceDir);
    const serviceFiles = files.filter(file => file.startsWith(`scrypted-${suffix}`) && file.endsWith('.service'));

    return serviceFiles.map(file => path.join(serviceDir, file));
}

export function getServiceFileBasename(suffix: string, nativeId: string) {
    return `scrypted-${suffix}-${nativeId}.service`;
}

export function getServiceFile(suffix: string, nativeId: string) {
    return `/etc/systemd/system/${getServiceFileBasename(suffix, nativeId)}`;
}

export async function removeServiceFile(suffix: string, nativeId: string, console: Console) {
    await systemctlStop(suffix, nativeId, console);
    await systemctlDisable(suffix, nativeId, console);
    await fs.promises.rm(getServiceFile(suffix, nativeId), {
        force: true,
    });
    await systemctlDaemonReload(console);
}

export async function systemctlStop(suffix: string, nativeId: string, console: Console) {
    await runSystemctlCommand('stop', [getServiceFileBasename(suffix, nativeId)], console);
}

export async function systemctlStart(suffix: string, nativeId: string, console: Console) {
    await runSystemctlCommand('start', [getServiceFileBasename(suffix, nativeId)], console);
}

export async function systemctlRestart(suffix: string, nativeId: string, console: Console) {
    await runSystemctlCommand('restart', [getServiceFileBasename(suffix, nativeId)], console);
}

export async function systemctlDisable(suffix: string, nativeId: string, console: Console) {
    await runSystemctlCommand('disable', [getServiceFileBasename(suffix, nativeId)], console);
}

export async function systemctlEnable(suffix: string, nativeId: string, console: Console) {
    await runSystemctlCommand('enable', [getServiceFileBasename(suffix, nativeId)], console);
}

export async function systemctlDaemonReload(console: Console) {
    await runSystemctlCommand('daemon-reload', [], console);
}
