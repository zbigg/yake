import * as ChildProcess from "child_process";
import * as debugCtor from "debug";
import { promises as fs } from "fs";

const debug = debugCtor("jsMake:utils");

export type ShellCommand = string | string[];

interface SpawnResult {
    output: string;
    stdout: string;
    stderr: string;
    status: number;
}

/**
 * `options.stdio` defaults to `[pipe,inherit,inherit]` so stderr and stdio is left as is (usually terminal)
 *
 * @param command
 * @param argsArr
 * @param options
 */
export function captureCommand(
    command: string,
    argsArr: string[],
    options: ChildProcess.SpawnOptions
): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
        const result: SpawnResult = {
            output: "",
            stdout: "",
            stderr: "",
            status: -1
        };
        options = {
            ...options,
            stdio: options.stdio || ['ignore', 'pipe', 'inherit']
        };
        debug(`spawning: ${command} ${argsArr.join(" ")}`)
        const cmd = ChildProcess.spawn(command, argsArr, options);
        cmd.on("close", code => {
            result.status = code;
            resolve(result);
        });
        cmd.stdout.on("data", data => {
            result.stdout += data;
            result.output += data;
        });
        // if (f)
        //     cmd.stderr.on("data", data => {
        //         result.stderr += data;
        //         result.output += data;
        //     });
        cmd.on("error", reject);
    });
}

export async function asyncCollect<T>(x: Array<Promise<T>>): Promise<T[]> {
    return [].concat(...await Promise.all(x));
}

export async function asyncCollectFlat<T>(x: Array<Promise<T[]>>): Promise<T[]> {
    return [].concat(...await Promise.all(x));
}

export async function readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
}
