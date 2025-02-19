import { runCommand, startCommand } from "./cli";

export async function ifup(iface: string, console: Console) {
    return runCommand('ifup', ['-f', iface], console);
}

export async function ifdown(iface: string, console: Console) {
    return runCommand('ifdown', [iface], console);
}
