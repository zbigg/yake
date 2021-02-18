import { TaskBuilder } from "../index";

export interface ModuleInfo {
    path: string;
    type: string;
}

interface ModuleBuilder {
    moduleInfo: ModuleInfo;
    taskBuilders: Map<string, TaskBuilder>;
}

export interface WorldBuilder {
    module(root: string): ModuleBuilder;
    task(moduleBuildeR: ModuleBuilder, name: string): TaskBuilder;
}

export interface Plugin {
    analyzeRoot(root: string, world: WorldBuilder): Promise<ModuleInfo[]>;
}

export const plugins: Plugin[] = [];
