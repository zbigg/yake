#!/usr/bin/env node

//
// Bring Makefile back to npm ecosystem.
//

import * as ChildProcess from "child_process";
import * as chokidar from "chokidar";
import * as createDebug from "debug";
import * as fs from "fs";
import * as glob from "glob";
import * as _ from "lodash";
import * as os from "os";
import * as path from "path";
import * as yargs from "yargs";

// tslint:disable:no-console

const debug = createDebug("yake");

const globCache = {};
const globStatCache: { [path: string]: fs.Stats } = {};

/**
 * Public `glob.sync` implementation that shares `stat` cache with main task runner engine.
 */
export const globSync = (paths: string) => {
    return glob.sync(paths, {
        cache: globCache,
        statCache: globStatCache,
        stat: true,
        nodir: true
    });
};

// TODO: cli for this
const verbose = false;
const quiet = false;
const dryRun = false;

export interface BaseTask {
    depends?: string[];
    affects?: string[];
    locks?: string | string[];
    outputs?: string[];
    cancellable?: boolean;
}

export interface CompoundTask extends BaseTask {
    depends: string[];
}
export interface NpmTask extends BaseTask {
    type: "npm";
}
export interface ShellTask extends BaseTask {
    recipe: string | string[];
}

export interface PluginTask extends BaseTask {
    type: string;
}

export type Task = (NpmTask | ShellTask | CompoundTask) & { name: string };
export type BaseTaskParams = NpmTask | ShellTask | CompoundTask | PluginTask;

export type NamedTaskList = Task[];
export interface TaskDict {
    [name: string]: BaseTaskParams;
}

export type Tasks = NamedTaskList | TaskDict;

export function isNpmTask(task: BaseTaskParams): task is NpmTask {
    return (task as any).type === "npm";
}

export function isShellTask(task: BaseTaskParams): task is ShellTask {
    return typeof (task as any).recipe === "string" || Array.isArray((task as any).recipe);
}

//
// Utility functions
//
function A<T>(c: Set<T> | T[] | Map<any, T> | { [name: string]: T } | T): T[] {
    if (c instanceof Set) {
        return Array.from(c.values());
    } else if (c instanceof Map) {
        return Array.from(c.values());
    } else if (Array.isArray(c)) {
        return c;
    } else if (typeof c === "object") {
        return Object.values(c);
    } else {
        return [c];
    }
}

export class CancellationToken {
    canceled: boolean = false;

    addCancelListener(newCallback: () => void) {
        const oldCallback = this.callback;
        this.callback = () => {
            oldCallback();
            newCallback();
        };
    }

    cancel() {
        this.canceled = true;
        this.callback();
    }

    reset() {
        this.canceled = false;
        this.callback = () => {
            /* */
        };
    }

    private callback: () => void = () => {
        /* */
    };
}

//
// Process & OS Utils
//
export interface ProcessResult {
    exitCode: number;
    capturedOutput: string[];
}

export function promisedShell(
    command: string | string[],
    options?: ChildProcess.SpawnOptions & { cancellationToken?: CancellationToken }
): Promise<ProcessResult> {
    const defaultSpawnOptions: ChildProcess.SpawnOptions = {
        shell: true,
        env: process.env,
        stdio: ["inherit", "pipe", "pipe"],
        // TODO:
        //   Decide how to handle CTRL+C and other interruptions
        //   - 'robust cancel management'
        //     We start all tasks in detached mode, so they get their own process group, so we
        //     can kill/cancel (including any complicated process tree) them at will.
        //     Pros: Can cancel particular tasks, Possibly correct CTRL+C management
        //     Cons: Complicated, have to manage CTRL+C and propagate to all subprocess groups,
        //        kill -9 on us doesn't leaves all tasks dangling
        //        note sure about windows :/
        //   If we want to be able to cancel tasks by ourselves, we need to create
        //   - 'interrupt only by shell'
        //     If we don't use detached, we actually can't reliably kill subtask's process tree
        //     as we live in subprocess group created by shell, so, only shell can kill whole process
        //     tree, including US :/
        //     Good - portable, simple, robust handling of CTRL+C
        //     Cons - we can't kill whole process trees of subtasks
        detached: true
    };

    if (dryRun) {
        return Promise.resolve({ exitCode: 0, capturedOutput: [] });
    }
    return new Promise((resolve, reject) => {
        const spawnOptions = { ...defaultSpawnOptions, options };
        const subProcess = Array.isArray(command)
            ? ChildProcess.spawn(command[0], command.slice(1), spawnOptions)
            : ChildProcess.spawn(command, spawnOptions);

        const capturedOutput: string[] = [];
        function captureOutput(data: string) {
            capturedOutput.push(String(data));
        }
        subProcess.stderr!.on("data", captureOutput);
        subProcess.stdout!.on("data", captureOutput);
        subProcess.on("error", err => {
            reject(new Error(`command failed: error spawning process: ${err}`));
        });

        subProcess.on("exit", code => {
            if (code === 0) {
                resolve({
                    exitCode: code,
                    capturedOutput
                });
            } else if (code !== null) {
                resolve({
                    exitCode: code,
                    capturedOutput
                });
            } else {
                resolve({
                    exitCode: 1,
                    capturedOutput
                });
            }
        });
        if (options && options.cancellationToken) {
            options.cancellationToken.addCancelListener(() => {
                try {
                    if (spawnOptions.detached) {
                        process.kill(-subProcess.pid, "SIGINT");
                    } else {
                        subProcess.kill("SIGINT");
                        process.kill(subProcess.pid, "SIGINT");
                    }
                } catch (error) {
                    console.warn(`failed to kill ${subProcess.pid}: ${error}`);
                }
            });
        }
    });
}

function* processOutputLineIterator(processOutput: string[]) {
    let nextEntryIndex = 0;
    let notEmittedLeftOver: string = "";
    let unparsedEntry = processOutput[nextEntryIndex++];
    let parsePosition = 0;
    while (true) {
        const eofIndex = unparsedEntry.indexOf("\n", parsePosition);
        const shouldSplit = eofIndex !== -1 && eofIndex !== unparsedEntry.length - 1;
        if (shouldSplit) {
            const splittedFragment = unparsedEntry.substr(parsePosition, eofIndex - parsePosition);

            yield notEmittedLeftOver + splittedFragment;
            notEmittedLeftOver = "";
            parsePosition = eofIndex + 1;
        } else {
            const endsWithLine = eofIndex === unparsedEntry.length - 1;
            const fragment = endsWithLine
                ? unparsedEntry.substr(parsePosition, eofIndex - parsePosition)
                : unparsedEntry;
            if (!endsWithLine) {
                notEmittedLeftOver += fragment;
            } else {
                yield notEmittedLeftOver + fragment;
                notEmittedLeftOver = "";
            }

            if (nextEntryIndex === processOutput.length) {
                break;
            }
            unparsedEntry = processOutput[nextEntryIndex++];
            parsePosition = 0;
        }
    }
    if (notEmittedLeftOver) {
        yield notEmittedLeftOver;
    }
}

function dumpProcessOutputPrefixed(text: string[], prefix: string): void {
    for (const line of processOutputLineIterator(text)) {
        process.stderr.write(`[${prefix}]\t${line}\n`);
    }
}

function logTaskMessage(rt: RuntimeTask, ...args: any[]) {
    console.log(`[${rt.task.name}]`, ...args);
}

export async function runShellTask(
    command: string | string[],
    taskName: string,
    cancellationToken: CancellationToken
): Promise<void> {
    if (!quiet) {
        console.log(`[${taskName}] \$ ${Array.isArray(command) ? command.join(" ") : command}`);
    }

    const result = await promisedShell(command, { cancellationToken });

    const commandStr = Array.isArray(command) ? command.join(" ") : command;
    if (cancellationToken.canceled) {
        if (verbose) {
            process.stderr.write(`[${taskName}] canceled, command '${commandStr}' output follows:\n`);
            dumpProcessOutputPrefixed(result.capturedOutput, taskName);
        }
        return Promise.reject(new Error(`canceled`));
    }
    if (result.exitCode !== 0) {
        process.stderr.write(
            // tslint:disable-next-line:max-line-length
            `[${taskName}] command '${commandStr}' failed (exit code ${result.exitCode}), output follows:\n`
        );
        dumpProcessOutputPrefixed(result.capturedOutput, taskName);
        return Promise.reject(new Error(`task failed`));
    }
    if (verbose) {
        process.stderr.write(`[${taskName}] command '${commandStr}' output follows:\n`);
        dumpProcessOutputPrefixed(result.capturedOutput, taskName);
    }
    return;
}

async function runPluginTask(task: PluginTask, cancellationToken: CancellationToken): Promise<void> {
    if (task.type === 'typescript') {
        const typescriptPlugin = require("./plugins/typescript");

        // todo needed files
        const compilationOptions = { listEmittedFiles: true };
        await typescriptPlugin.compile(task.depends || [], compilationOptions, cancellationToken);
    } else {
        console.log("#runPluginTask: unknown plugin", task.type)
    }
}
console.log("#6");

interface ConcurrentRunContext {
    freeSlots: number;
    participants: Set<() => void>;
}

function createConcurrentRunContext(maxJobs: number): ConcurrentRunContext {
    return {
        freeSlots: maxJobs,
        participants: new Set()
    };
}

namespace ConcurrentRunContext {
    export function signal(context: ConcurrentRunContext) {
        context.participants.forEach(p => p());
    }
    export function addParticipant(context: ConcurrentRunContext, step: () => void) {
        context.participants.add(step);
    }
    export function removeParticipant(context: ConcurrentRunContext, step: () => void) {
        context.participants.delete(step);
    }
}

function concurrentMap<T, R>(
    input: T[],
    context: ConcurrentRunContext,
    fun: (x: T, idx: number) => Promise<R>
): Promise<R[]> {
    return new Promise((resolve, reject) => {
        const result: R[] = [];
        result.length = input.length;

        let runningJobs = 0;
        let nextItemIndex = 0;
        let finishedCount = 0;
        let firstError: Error | undefined;

        function step() {
            if (finishedCount === input.length) {
                resolve(result);

                ConcurrentRunContext.removeParticipant(context, step);
                ConcurrentRunContext.signal(context);
                return;
            }
            if (firstError !== undefined) {
                if (runningJobs === 0) {
                    ConcurrentRunContext.removeParticipant(context, step);
                    reject(firstError);
                }

                ConcurrentRunContext.signal(context);
                // Don't start new jobs if something failed.
                return;
            }

            // Start as many jobs as we have slots free.
            while (context.freeSlots > 0 && nextItemIndex < input.length) {
                const itemIndex = nextItemIndex++;
                const inputItem = input[itemIndex];
                context.freeSlots -= 1;
                runningJobs += 1;
                const itemPromise = fun(inputItem, nextItemIndex);

                itemPromise
                    .then(itemResult => {
                        result[itemIndex] = itemResult;
                        context.freeSlots += 1;
                        runningJobs -= 1;
                        finishedCount += 1;
                    })
                    .catch(error => {
                        context.freeSlots += 1;
                        runningJobs -= 1;

                        if (firstError !== undefined) {
                            firstError = error;
                        }
                    })
                    .then(step);
            }
        }
        ConcurrentRunContext.addParticipant(context, step);
        step();
    });
}

/*
function concurrentRun<R>(context: ConcurrentRunContext, fun: () => R | Promise<R>): Promise<R> {
    return new Promise((resolve, reject) => {
        function step() {
            if (context.freeSlots === 0) {
                return;
            }
            const itemPromise = Promise.resolve(fun());
            context.freeSlots -= 1;

            ConcurrentRunContext.removeParticipant(context, step);

            itemPromise
                .then(itemResult => {
                    context.freeSlots += 1;
                    resolve(itemResult);

                    ConcurrentRunContext.signal(context);
                })
                .catch(error => {
                    context.freeSlots += 1;
                    reject(error);

                    ConcurrentRunContext.signal(context);
                });
        }
        ConcurrentRunContext.addParticipant(context, step);
        step();
    });
}
*/

function isCompoundTask(task: any): task is CompoundTask {
    return Array.isArray(task.depends) && task.depends.length > 0 && !isNpmTask(task) && !isShellTask(task) && !isPluginTask(task);
}

function isPluginTask(task: any): task is PluginTask {
    return typeof task.type === 'string' && !isNpmTask(task) && !isShellTask(task);
}

namespace Task {
    export async function runTaskRecipe(task: Task, cancellationToken: CancellationToken): Promise<void> {
        if (isNpmTask(task)) {
            return runShellTask(`yarn run ${task.name}`, task.name, cancellationToken);
        } else if (isShellTask(task)) {
            if (Array.isArray(task.recipe)) {
                for (const recipeEntry of task.recipe) {
                    await runShellTask(recipeEntry, task.name, cancellationToken);
                }
            } else {
                return runShellTask(task.recipe, task.name, cancellationToken);
            }
        } else if (isPluginTask(task)) {
            return runPluginTask(task, cancellationToken);
        } else {
            // ???
        }
    }

    export async function loadNpmTasks(packageJsonPath: string): Promise<TaskDict> {
        const packageJson = await new Promise<any>((resolve, reject) => {
            fs.readFile(packageJsonPath, { encoding: "utf-8" }, (err, content) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(JSON.parse(content));
                }
            });
        });
        if (!packageJson.scripts) {
            return {};
        }
        return Object.keys(packageJson.scripts).reduce(
            (result, scriptName) => {
                result[scriptName] = { type: "npm" };
                return result;
            },
            ({} as unknown) as TaskDict
        );
    }

    export function mergeTaskLists(a: Tasks, b: Tasks): TaskDict {
        return _.merge(makeTaskDict(a), makeTaskDict(b));
    }

    export function makeTaskList(tasks: Tasks): NamedTaskList {
        if (!Array.isArray(tasks)) {
            return Object.keys(tasks).map(name => {
                const task: BaseTaskParams = (tasks as any)[name];
                return ({ ...task, name } as unknown) as Task;
            });
        } else {
            return tasks;
        }
    }
    export function makeTaskDict(tasks: Tasks): TaskDict {
        if (Array.isArray(tasks)) {
            return tasks.reduce(
                (result, task) => {
                    const { name, ...rest } = task;
                    result[name] = rest;
                    return result;
                },
                ({} as unknown) as TaskDict
            );
        } else {
            return tasks;
        }
    }
}

interface FileStatus {
    exists: boolean;
    modifiedTime?: number;
}

interface FileInfo {
    path: string;

    status?: FileStatus;
    statPromise?: Promise<FileStatus>;

    neededBy: RuntimeTask[];
    providedBy?: RuntimeTask;
}

function getFileStatus(file: FileInfo): Promise<FileStatus> {
    if (file.status !== undefined) {
        return Promise.resolve(file.status);
    }
    if (file.statPromise === undefined) {
        const absPath = path.resolve(process.cwd(), file.path);
        const cached = globStatCache[absPath];
        if (cached) {
            file.status = {
                exists: true,
                modifiedTime: Math.max(cached.mtimeMs, cached.ctimeMs)
            };
            return Promise.resolve(file.status);
        }

        file.statPromise = new Promise(resolve => {
            fs.stat(file.path, (err, stats) => {
                if (err) {
                    resolve(
                        (file.status = {
                            exists: false
                        })
                    );
                } else {
                    resolve(
                        (file.status = {
                            exists: true,
                            modifiedTime: Math.max(stats.mtimeMs, stats.ctimeMs)
                        })
                    );
                }
            });
        });
    }
    return file.statPromise;
}

function looksLikeFileName(taskName: string) {
    return taskName.startsWith("./") || taskName.startsWith("/");
}

const fileStatusParallelContext = createConcurrentRunContext(32);

type RuntimeTaskStatus = "unknown" | "needed" | "executing" | "done" | "failed" | "skipped" | "canceled";

class RuntimeTask {
    task: Task;
    status: RuntimeTaskStatus;

    needs: RuntimeTask[] = [];
    neededBy: RuntimeTask[] = [];

    needsFile: FileInfo[] = [];
    needsFileQuery?: Promise<FileStatus[]>;
    producesFile: FileInfo[] = [];
    producesFileQuery?: Promise<FileStatus[]>;

    cancellationToken = new CancellationToken();

    constructor(task: Task) {
        this.task = task;
        this.status = "unknown";
    }
}

interface RuntimeState {
    runtimeTasks: Map<string, RuntimeTask>;
    files: Map<string, FileInfo>;
}

interface SerializedTaskState {
    task: Task;
    status: "unknown" | "failed" | "done";
}

interface SerializedState {
    [taskName: string]: SerializedTaskState;
}

namespace RuntimeState {
    export function getFile(runtimeState: RuntimeState, filePath: string): FileInfo {
        let f = runtimeState.files.get(filePath);
        if (f === undefined) {
            f = { path: filePath, neededBy: [] };
            runtimeState.files.set(filePath, f);
        }
        return f;
    }

    export function buildRuntimeTaskList(tasks: Tasks): RuntimeState {
        const runtimeTasks: RuntimeTask[] = [];
        const result: RuntimeState = {
            runtimeTasks: new Map<string, RuntimeTask>(),
            files: new Map<string, FileInfo>()
        };

        tasks = Task.makeTaskList(tasks);

        // add all tasks to map by name
        for (const task of tasks) {
            const rt = new RuntimeTask(task);
            result.runtimeTasks.set(task.name, rt);
            runtimeTasks.push(rt);
        }

        debug(
            "#buildRuntimeTaskList task status",
            result.runtimeTasks.size,
            A(result.runtimeTasks)
                //.filter(rt => rt.status === "needed")
                .map(rtx => `${rtx.task.name} => ${rtx.status}`)
                .join(", ")
        );

        // process all "outputs" and "affects" edges
        for (const rt of runtimeTasks) {
            if (Array.isArray(rt.task.outputs)) {
                for (const fileName of rt.task.outputs) {
                    const fi = RuntimeState.getFile(result, fileName);
                    fi.providedBy = rt;
                    rt.producesFile.push(fi);

                    // TODO: should we even export file names as task names ?
                    //result.runtimeTasks.set(fileName, rt);
                }
            }
            if (Array.isArray(rt.task.affects)) {
                for (const fileName of rt.task.affects) {
                    const fi = RuntimeState.getFile(result, fileName);
                    fi.providedBy = rt;
                }
            }
        }
        // create links for all "depends" edges
        for (const rt of runtimeTasks) {
            if (!rt.task.depends || rt.task.depends.length === 0) {
                continue;
            }
            for (const depName of rt.task.depends) {
                const dep = result.runtimeTasks.get(depName);
                if (dep === undefined) {
                    if (looksLikeFileName(depName)) {
                        const fi = RuntimeState.getFile(result, depName);
                        rt.needsFile.push(fi);
                        fi.neededBy.push(rt);
                        continue;
                    } else {
                        throw new Error(`${rt.task.name}: unknown dependency: ${depName}`);
                    }
                }
                rt.needs.push(dep);
                dep.neededBy.push(rt);
            }
        }

        return result;
    }

    export function resetFileInfoCaches(rt: RuntimeTask) {
        rt.producesFileQuery = undefined;
        rt.needsFileQuery = undefined;
    }

    export async function runTask(rt: RuntimeTask, cancellationToken: CancellationToken): Promise<void> {
        if (rt.producesFileQuery === undefined) {
            if (rt.producesFile.length > 0) {
                debug(`#processFiles ${rt.task.name} checking output files`);
                rt.producesFileQuery = concurrentMap(rt.producesFile, fileStatusParallelContext, fi => {
                    return getFileStatus(fi);
                });
            } else {
                rt.producesFileQuery = Promise.resolve([]);
            }
        }

        if (rt.needsFileQuery === undefined) {
            if (rt.needsFile.length > 0) {
                debug(`#runTask ${rt.task.name} checking input files`);
                rt.needsFileQuery = concurrentMap(rt.needsFile, fileStatusParallelContext, fi => {
                    return getFileStatus(fi);
                });
            } else {
                rt.needsFileQuery = Promise.resolve([]);
            }
        }

        const [producesFileStatues, neededFileStatuses] = await Promise.all([rt.producesFileQuery, rt.needsFileQuery]);

        let minOutputFileTime: number | undefined = Number.MAX_SAFE_INTEGER;
        let maxInputFileTime: number | undefined = 0;
        let allOutputsExist: boolean = true;
        let allInputExist: boolean = true;

        for (const fStatus of producesFileStatues) {
            if (fStatus.modifiedTime !== undefined) {
                minOutputFileTime = Math.min(minOutputFileTime, fStatus.modifiedTime);
            }
            allOutputsExist = allOutputsExist && fStatus.exists;
        }

        // let missingFiles = string[];
        for (const fStatus of neededFileStatuses) {
            if (fStatus.modifiedTime !== undefined) {
                maxInputFileTime = Math.max(maxInputFileTime, fStatus.modifiedTime);
            }
            allInputExist = allInputExist && fStatus.exists;
            // TODO: fStatus doesn't contain path, need to iterate over all FileInfos
            //if (!fStatus.exists) {
            //    missingFiles.push(fStatus.)
            //}
        }

        if (!allInputExist) {
            // TODO: log missing files
            throw new Error(`${rt.task.name}: some files are missing`);
        }
        if (
            producesFileStatues.length > 0 &&
            allOutputsExist &&
            allInputExist &&
            minOutputFileTime > maxInputFileTime
        ) {
            logTaskMessage(rt, "ok, nothing to be done");
            return;
        }

        return Task.runTaskRecipe(rt.task, cancellationToken);
    }

    export function serialize(runtimeState: RuntimeState): SerializedState {
        return Object.keys(runtimeState.runtimeTasks).reduce(
            (r, taskName) => {
                const rt = runtimeState.runtimeTasks.get(taskName)!;
                r[taskName] = {
                    task: rt.task,
                    status: rt.status === "done" ? "done" : "unknown"
                };
                return r;
            },
            ({} as any) as SerializedState
        );
    }

    // export function applySerializedState(
    //     runtimeState: RuntimeState,
    //     serializedState: SerializedState
    // ) {
    //     for (const taskName of serializedState) {
    //         // if (serializedState,)
    //     }
    // }
}

export type NextStepCallback = (rt?: RuntimeTask) => void;

class WatchManager {
    private watcher: chokidar.FSWatcher | undefined;
    private watchMarkedTasks = new Set<RuntimeTask>();
    private nextStepTriggerDebounced: () => void;
    private debouncedLogMarkedRebuild = _.debounce(() => {
        if (this.watchMarkedTasks.size === 0) {
            return;
        }
        console.log(
            `(watch, files changed, will rebuild: ${A(this.watchMarkedTasks)
                .map(rt => rt.task.name)
                .join(", ")})`
        );
    });

    constructor(readonly runtimeState: RuntimeState, readonly nextStepTrigger: NextStepCallback) {
        this.nextStepTriggerDebounced = _.debounce(nextStepTrigger);
    }

    registerTask(rt: RuntimeTask) {
        const paths = rt.needsFile.map(fi => fi.path);
        if (this.watcher === undefined) {
            this.watcher = chokidar.watch(paths, { disableGlobbing: true });
            this.watcher.on("change", this.onFileChanged);
        } else {
            this.watcher.add(paths);
        }
    }

    pedingTriggersCount() {
        return this.watchMarkedTasks.size;
    }

    consumePendingTriggers() {
        const r = this.watchMarkedTasks;
        this.watchMarkedTasks = new Set();
        return r;
    }

    private onFileChanged = (filePath: string, stats: fs.Stats) => {
        const fi = RuntimeState.getFile(this.runtimeState, filePath);
        fi.status = {
            exists: true,
            modifiedTime: Math.max(stats.mtimeMs, stats.ctimeMs)
        };
        debug(
            "#watch #onFileChanged %s",
            filePath,
            fi.neededBy.filter(rt => rt.status !== "unknown").map(rt => rt.task.name)
        );

        this.markForRebuildDeep(fi.neededBy);
    };

    private markForRebuildDeep(tasksToRebuild: RuntimeTask[]) {
        for (const rt of tasksToRebuild) {
            if (rt.status === "unknown") {
                continue;
            }
            debug("#markForRebuildDeep marking", rt.task.name);
            this.watchMarkedTasks.add(rt);
            if (rt.status === "executing" && rt.task.cancellable !== false) {
                if (!rt.cancellationToken.canceled) {
                    logTaskMessage(rt, "...cancelling");
                    rt.cancellationToken.cancel();
                }
            }
            if (rt.neededBy) {
                this.markForRebuildDeep(rt.neededBy);
            }
        }

        this.debouncedLogMarkedRebuild();
        this.nextStepTriggerDebounced();
    }
}

class LockManager {
    private locks: Set<string> = new Set();
    private lockedTasks: Set<RuntimeTask> = new Set();

    constructor(readonly nextStepCallback: NextStepCallback) { }

    acquireLocks(rt: RuntimeTask): boolean {
        let lockNames = rt.task.locks;
        if (!lockNames) {
            return true;
        }
        if (typeof lockNames === "string") {
            lockNames = [lockNames];
        }
        const acquired: string[] = [];
        let ok = true;
        for (const lockName of lockNames) {
            if (this.locks.has(lockName)) {
                ok = false;
            } else {
                this.locks.add(lockName);
                acquired.push(lockName);
            }
        }
        if (!ok && acquired.length > 0) {
            this.doReleaseLocks(acquired);
        }
        if (!ok) {
            this.lockedTasks.add(rt);
        }
        return ok;
    }

    releaseLocks(rt: RuntimeTask) {
        let lockNames = rt.task.locks;
        if (!lockNames) {
            return;
        }
        if (typeof lockNames === "string") {
            lockNames = [lockNames];
        }
        this.doReleaseLocks(lockNames);

        // re-add all stuff, so locks will be checked next task is done
        for (const otherRt of this.lockedTasks) {
            this.nextStepCallback(otherRt);
        }
        this.lockedTasks.clear();
    }
    private doReleaseLocks(lockNames: string[]) {
        for (const lockName of lockNames) {
            this.locks.delete(lockName);
        }
    }
}

async function runTasks(taskNames: string[], tasks: Tasks, params: YakeParams): Promise<boolean> {
    const { shutdownToken, watch } = params;
    if (params.packageJsonPath !== undefined) {
        const packageJsonTasks = await Task.loadNpmTasks(params.packageJsonPath);
        debug("#runTasks packageJsonTasks", packageJsonTasks);
        tasks = Task.mergeTaskLists(packageJsonTasks, tasks);
        debug("#runTasks mergedTasks", tasks);
    }

    const runtimeState = RuntimeState.buildRuntimeTaskList(tasks);

    let processingStep: () => void;
    let tasksToReprocess: Set<RuntimeTask> = new Set();

    function requestReprocess(rt?: RuntimeTask) {
        if (rt) {
            tasksToReprocess.add(rt);
        }
        requestNextStep();
    }

    let nextStepScheduled = false;
    function requestNextStep() {
        if (!nextStepScheduled) {
            process.nextTick(processingStep);
            nextStepScheduled = true;
        }
    }

    const watcher = new WatchManager(runtimeState, requestReprocess);
    const locker = new LockManager(requestReprocess);

    const needed: Set<RuntimeTask> = new Set();
    const done: Set<RuntimeTask> = new Set();
    const succeeded = new Set<RuntimeTask>();
    const failed = new Set<RuntimeTask>();
    const skipped = new Set<RuntimeTask>();
    const canceled = new Set<RuntimeTask>();
    const executing = new Set<RuntimeTask>();

    const readyForExecution: RuntimeTask[] = [];

    taskNames.forEach(taskName => {
        const rt = runtimeState.runtimeTasks.get(taskName);
        if (rt === undefined) {
            throw new Error(`unknown task ${taskName}`);
        }
        markNeeded(rt);
    });

    debug(
        "#runTasks",
        A(runtimeState.runtimeTasks)
            //.filter(rt => rt.status === "needed")
            .map(rt => `${rt.task.name} => ${rt.status}`)
            .join(", ")
    );

    function setTaskStatus(rt: RuntimeTask, newStatus: RuntimeTaskStatus) {
        const oldStatus = rt.status;
        if (newStatus === oldStatus) {
            return;
        }
        rt.status = newStatus;

        function updateSet(set: Set<RuntimeTask>, flag: boolean) {
            const flagAlreadySet = set.has(rt);
            if (flagAlreadySet === flag) {
                return;
            }
            if (flag) {
                set.add(rt);
            } else {
                set.delete(rt);
            }
        }

        const hasSucceeded = rt.status === "done";
        const hasFailed = rt.status === "failed";
        const hasBeenSkipped = rt.status === "skipped";
        const hasBeenCanceled = rt.status === "canceled";

        const isNeeded =
            hasSucceeded ||
            hasFailed ||
            hasBeenSkipped ||
            hasBeenCanceled ||
            rt.status === "needed" ||
            rt.status === "executing";

        updateSet(needed, isNeeded);
        const isDone = hasSucceeded || hasFailed || hasBeenSkipped || hasBeenCanceled;
        updateSet(done, isDone);
        updateSet(failed, hasFailed);
        updateSet(succeeded, hasSucceeded);
        updateSet(skipped, hasBeenSkipped);
        updateSet(canceled, hasBeenCanceled);
        updateSet(executing, rt.status === "executing");

        debug(`#setTaskStatus ${rt.task.name} ${oldStatus} => ${newStatus}`, {
            needed: needed.size,
            done: done.size,
            succeeded: succeeded.size,
            failed: failed.size,
            skipped: skipped.size,
            canceled: canceled.size
        });

        if (watch) {
            if (oldStatus === "unknown" && newStatus === "needed") {
                watcher.registerTask(rt);
            }
        }

        // propagate failed/skipped state to all tasks that depend on us
        if (hasFailed || hasBeenSkipped || hasBeenCanceled) {
            for (const dep of rt.neededBy) {
                if (dep.status === "unknown") {
                    continue;
                }
                if (dep.status !== "failed") {
                    debug(`#setTaskStatus propagating ${newStatus} to ${dep.task.name}`);
                    setTaskStatus(dep, newStatus);
                }
            }
        }

        // propagate needed state up to all tasks we depend on
        if (isNeeded) {
            for (const dep of rt.needs) {
                if (dep.status === "unknown") {
                    debug(`#setTaskStatus propagating ${newStatus} to ${dep.task.name}`);
                    setTaskStatus(dep, "needed");
                }
            }
        }
        markCandidatesForExecution(rt);
    }

    function markCandidatesForExecution(rt: RuntimeTask, forceNeeded?: boolean): boolean {
        if (rt.status === "done" || rt.status === "skipped" || rt.status === "failed" || rt.status === "canceled") {
            return true;
        }
        if (rt.status === "executing") {
            return false;
        }
        if (forceNeeded && rt.status === "unknown") {
            setTaskStatus(rt, "needed");
        }
        if (rt.status === "needed") {
            const depsDone = checkTaskDepsStatus(rt, forceNeeded);
            if (!depsDone) {
                return false;
            }

            if (isCompoundTask(rt.task)) {
                debug("%s is compound and all deps are ok -> done", rt.task)
                setTaskStatus(rt, "done");
            } else {
                readyForExecution.push(rt);
            }
        }
        return false;
    }

    function checkTaskDepsStatus(rt: RuntimeTask, forceNeeded?: boolean) {
        let depsDone = true;
        for (const dep of rt.needs) {
            switch (dep.status) {
                case "unknown":
                    markCandidatesForExecution(dep, forceNeeded);
                    depsDone = false;
                    break;
                case "needed":
                case "executing":
                    depsDone = false;
                    break;
            }
        }
        return depsDone;
    }

    function markNeeded(rt: RuntimeTask): boolean {
        return markCandidatesForExecution(rt, true);
    }

    function getOverallTaskStatusText() {
        const statusEntries: string[] = [];
        if (failed.size > 0) {
            statusEntries.push(`FAILED: ${failed.size}`);
        }
        if (skipped.size > 0) {
            statusEntries.push(`skipped: ${skipped.size}`);
        }
        if (succeeded.size > 0) {
            statusEntries.push(`ok: ${succeeded.size}`);
        }
        if (executing.size > 0) {
            statusEntries.push(`running: ${executing.size}`);
        }
        const pending = needed.size - done.size - executing.size;
        if (pending > 0) {
            statusEntries.push(`pending: ${pending}`);
        }

        return statusEntries.length > 0 ? `(${statusEntries.join(" ")})` : "";
    }

    function processWatchTriggers() {
        const watchMarkedTasks = watcher.consumePendingTriggers();

        for (const rt of watchMarkedTasks) {
            setTaskStatus(rt, "needed");
            RuntimeState.resetFileInfoCaches(rt);
            markCandidatesForExecution(rt);
        }
        const restartedTaskNames = Array.from(watchMarkedTasks)
            .map(rt => rt.task.name)
            .join(", ");
        console.log(`(watch: restarting ${restartedTaskNames})`);

        requestReprocess();
    }

    const tokens: number[] = [];
    for (let i = 0; i < params.jobsMax; ++i) {
        tokens.push(i);
    }

    shutdownToken.addCancelListener(() => {
        let somethingCancelled = false;
        for (const rt of runtimeState.runtimeTasks.values()) {
            if (rt.status === "executing") {
                rt.cancellationToken.cancel();
                somethingCancelled = true;
            }
        }
        if (somethingCancelled) {
            console.log(`interrupted (cleaning up)`, getOverallTaskStatusText());
        }
        requestReprocess();
    });

    return new Promise(resolve => {
        function step() {
            nextStepScheduled = false;
            const somethingRunning = tokens.length < params.jobsMax;

            debug("#step 1", {
                done: done.size,
                needed: needed.size,
                failed: failed.size,
                watchMarkedTasks: watcher.pedingTriggersCount()
            });
            if (!somethingRunning) {
                if (shutdownToken.canceled) {
                    console.log(`interrupted`, getOverallTaskStatusText());
                    resolve(false);
                    return;
                }
                if (watch) {
                    if (done.size === needed.size) {
                        if (watcher.pedingTriggersCount() > 0) {
                            processWatchTriggers();
                        } else {
                            console.log("(watching for changes)", getOverallTaskStatusText());
                        }
                    }
                } else {
                    if (failed.size > 0) {
                        console.log(`failure`, getOverallTaskStatusText());
                        resolve(false);
                        return;
                    } else if (done.size === needed.size) {
                        console.log(`success`, getOverallTaskStatusText());
                        resolve(true);
                        return;
                    }
                }
            }

            if (tasksToReprocess.size > 0) {
                const tmpTasks = tasksToReprocess;
                tasksToReprocess = new Set();

                for (const rt of tmpTasks) {
                    markCandidatesForExecution(rt);
                }
            }

            while (readyForExecution.length > 0 && tokens.length > 0) {
                const rt = readyForExecution.shift()!;
                if (rt.status !== "needed") {
                    debug(`skipped ${rt.task.name} as it is now ${rt.status}`);
                    continue;
                }
                if (shutdownToken.canceled) {
                    setTaskStatus(rt, "canceled");
                    requestNextStep();
                    continue;
                }
                if (failed.size > 0 && !params.keepGoing) {
                    logTaskMessage(rt, "skipped because of other failures", getOverallTaskStatusText());
                    setTaskStatus(rt, "skipped");
                    requestNextStep();
                    continue;
                }

                if (!locker.acquireLocks(rt)) {
                    continue;
                }
                const token = tokens.shift()!;

                logTaskMessage(rt, `starting`);
                setTaskStatus(rt, "executing");
                rt.cancellationToken.reset();

                RuntimeState.runTask(rt, rt.cancellationToken)
                    .then(() => {
                        locker.releaseLocks(rt);
                        tokens.push(token);

                        setTaskStatus(rt, "done");

                        for (const nextCandidate of rt.neededBy) {
                            markCandidatesForExecution(nextCandidate);
                        }
                        logTaskMessage(rt, "success", getOverallTaskStatusText());
                    })
                    .catch(error => {
                        locker.releaseLocks(rt);
                        tokens.push(token);

                        if (rt.cancellationToken.canceled) {
                            setTaskStatus(rt, "canceled");
                            logTaskMessage(rt, `canceled`, getOverallTaskStatusText());
                        } else {
                            setTaskStatus(rt, "failed");
                            logTaskMessage(rt, `failed: ${error.message}`, getOverallTaskStatusText());
                        }
                    })
                    .then(requestNextStep);
            }
        }
        processingStep = step;
        requestNextStep();
    });
}

export interface YakeParams {
    shutdownToken: CancellationToken;
    watch: boolean;
    jobsMax: number;
    keepGoing: boolean;
    packageJsonPath: string;
}

export const YAKE_DEFAULTS: Readonly<YakeParams> = {
    shutdownToken: new CancellationToken(),
    watch: false,
    keepGoing: false,
    jobsMax: os.cpus().length,
    packageJsonPath: path.resolve(process.cwd(), "./package.json")
};

export type YakeOptions = Partial<YakeParams>;

let yakeCliStarted = false;
export function yakeCli(tasks: Tasks, options?: YakeOptions) {
    yakeCliStarted = true;
    debug("XX", yakeCliStarted);

    const cliArgs = yargs
        .option("watch", {
            alias: "w",
            describe: "watch mode",
            type: "boolean",
            default: YAKE_DEFAULTS.watch
        })
        .option("keepGoing", {
            alias: "k",
            describe: "keep going",
            type: "boolean",
            default: YAKE_DEFAULTS.keepGoing
        })
        .option("jobs", {
            alias: "j",
            describe: "number of parallel jobs",
            type: "number",
            default: YAKE_DEFAULTS.jobsMax
        }).argv;
    debug("#yake cliArgs", cliArgs);

    const params: YakeParams = {
        ...YAKE_DEFAULTS,
        ...options,
        watch: cliArgs.watch,
        keepGoing: cliArgs.keepGoing,
        jobsMax: cliArgs.jobs
    };

    function gracefulShutdown() {
        params.shutdownToken.cancel();
    }

    process.on("SIGTERM", gracefulShutdown);
    process.on("SIGINT", gracefulShutdown);

    let tasksToRun: string[] = cliArgs._;
    if (tasksToRun.length === 0) {
        tasksToRun = ["build"];
    }

    runTasks(tasksToRun, tasks, params)
        .then(success => {
            process.exit(success ? 0 : 1);
        })
        .catch(error => {
            console.error(`yake: failed to run ${tasksToRun.join(",")}: ${error}`, error);
            process.exit(2);
        });
}
/**
 * Attempt to run
 */
async function yakeCliAuto() {
    debug("#yakeCliAuto");
    const candidates = ["./Yakefile.js", "./Yakefile.ts", "./Yakefile.json"];
    for (const name of candidates) {
        const fullPath = path.resolve(".", name);
        try {
            debug("#yakeCliAuto trying", fullPath, yakeCliStarted);
            const tasks: Tasks | undefined = require(fullPath);
            debug("#yakeCliAuto found!", fullPath, tasks, yakeCliStarted);
            if (tasks && _.size(tasks) > 0) {
                if ((global as any).yakeCliStarted) {
                    console.warn("yake: you've started CLI with `yakeCli` and returned definitions");
                    return;
                } else {
                    yakeCli(tasks);
                    return;
                }
            } else break;
        } catch (err) {
            debug("#yakeCliAuto failed", fullPath, err);
            continue;
        }
    }
    if (yakeCliStarted) {
        return;
    }
    console.warn("yake: no Yakefile(.js,.ts,.json) found, will use tasks from package.json");
    yakeCli({});
}

if (require.main === module) {
    yakeCliAuto();
}
