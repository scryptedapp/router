import child_process, { ChildProcess } from 'child_process';
import { once } from 'events';

export async function logToConsoleAndWait(cp: ChildProcess, console: Console) {
    await once(cp, 'exit');
}

export async function waitExit(cp: ChildProcess | undefined) {
    if (!cp)
        return;
    if (cp.exitCode !== null)
        return cp.exitCode;
    await once(cp, 'exit');
    return cp.exitCode;
}

export async function runCommand(command: string, args: string[], console: Console) {
    const cp = startCommand(command, args, console);
    await logToConsoleAndWait(cp, console);
}

export function startCommand(command: string, args: string[], console: Console) {
    console.log(command, ...args);
    const cp = child_process.spawn(command, args, {
        stdio: ['inherit', 'pipe', 'pipe'],
    });
    cp.stdout!.on('data', data => console.log(data.toString()));
    cp.stderr!.on('data', data => console.error(data.toString()));
    cp.on('exit', code => console.log(`${command} exited with code ${code}`));
    return cp;
}
