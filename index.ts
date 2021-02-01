
// task artifact lifecycle/flavors


// definition

    // should be able to configure static tree

// invocation of recipes, attempt to build

    // should receive all inputs in consumable flavor

// consumption

    // all outputs are resolved and visible as actual lists of files/resources


// Definitions
// Still not resovled, FileSet definition created usually by FileSetBuilder
export interface FileSet {
    paths: PathFilterEntry[];
    include: PathFilterEntry[] | undefined;
    exclude: PathFilterEntry[] | undefined;
}

export type Input = Task | FileSet;

export interface RecipeResult {
    success: boolean
    outputs?: string; // TODO
}
export type TaskRecipe = (this: TaskInstance) => Promise<RecipeResult>;
//
// Task Definition
//
// Contains declaration of inputs, dependencies and stuff
//
// Usually created by TaskBuilder
export interface Task {
    inputs: Input[];
    affects: Task[];

    // Like inputs, but not used in "main input list", may be implicitly used by recipe like
    // `package.json` or `.mocharc.json`
    requires: Input[];

    //
    outputs: FileSet[];

    recipe: TaskRecipe;
}

//
// Definitions
//
export type DepTreeNode = FileSetBuilder | TaskBuilder | FileSet | Task;
export type DepTreeFileNode = FileSetBuilder | FileSet | string | string[];

export interface DepsBuilder {
    affects(...tasks: DepTreeNode[]): this;
    requires(...tasks: DepTreeNode[]): this;
}

export interface FileSetBuilder extends DepsBuilder {
    buildFileSet(): FileSet;
    exclude(...paths: PathFilterEntry[]): this;
    include(...paths: PathFilterEntry[]): this;
}

export interface TaskBuilder extends DepsBuilder {
    buildTask(): Task;
    inputs(...tasks: DepTreeNode[]): this;
    outputs(...fileSets: DepTreeFileNode[]): this;
    withRecipe(x: TaskRecipe): this;
}

export interface FileInstance {
    path: string;
    otherStuff?: boolean;
}

/**
 * FileSet resolved in particular point of time.
 */
export interface ResolvedFileSet {
    definition: FileSet;
    files: FileInstance[];
}

export interface TaskInstance {
    inputs: ResolvedFileSet[];
    affects: TaskBuilder[];
    requires: TaskInstance[];
    outputs: FileSetBuilder[];

}
export type PathFilterEntry = string | RegExp;

export type FileSetLike = FileSetBuilder | string | string[];

export function makeDepsBuilder() {
    const affects: DepTreeNode[] = [];
    const requires: DepTreeNode[] = [];
    return {
        buildDeps() {
            return {
                affects,
                requires
            }
        },
        affects(...args: DepTreeNode[]) {
            affects.push(...args)
            return this;
        },
        requires(...args: DepTreeNode[]) {
            requires.push(...args)
            return this
        }
    }
}
export function makeTask(): TaskBuilder {
    const inputs: DepTreeNode[] = [];
    const outputs: DepTreeFileNode[] = [];
    let recipe: TaskRecipe | undefined;
    return {
        ...makeDepsBuilder(),
        buildTask() {
            if (!recipe) {
                throw new YakeDefinitionError('no recipe');
            }
            return {
                ...this.buildDeps(),
                inputs,
                outputs,
                recipe
            }
        },
        withRecipe(r: TaskRecipe) {
            recipe = r;
            return this;
        },
        inputs(...args: DepTreeNode[]) {
            inputs.push(...args);
            return this;
        },
        outputs(...args: DepTreeFileNode[]) {
            outputs.push(...args);
            return this;
        }
    }
}

export function makeFileSet(...base: FileSetLike[]): FileSetBuilder {
    return {
        ...makeDepsBuilder(),
        buildFileSet() {
            return {
                paths: [],
                include: [],
                exclude: []
            }
        },
        exclude() {
            return this;
        },
        include() {
            return this;
        }
    }
}

export function fileSet(...globs: string[]): FileSetBuilder { return makeFileSet() }
export function genericTask(def: any) { return makeTask() }


class YakeDefinitionError extends Error {
    constructor(message) {
        super(message)
        this.name = "YakeDefinitionError";
    }
}
