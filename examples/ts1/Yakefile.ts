
// import { fileSet, genericTask } from "yake";
import * as fs from "fs";
import { FileSetLike, makeFileSet, makeTask } from "../../index";

//
// import { typescript } from "yake-typescript";
function typescript(sourceSets: any, typescriptOptions: any) { return makeTask() }
function mocha(sourceSets: any, options?: any) { return makeTask() }
function prettier(options?: any) { return makeTask() }


// task artifact lifecycle

// definition

// invocation of recipes, attempt to build

// consumption

/// sample Yakefile

function firstAndOnlyOutput(base: FileSetLike[]) {
    return "";
}
export const yarnLock = makeFileSet("./yarn.lock");
export const packageJson = makeFileSet("./package.json");
export const outConfigJson = makeTask()
    .inputs(packageJson)
    .outputs("./out/config.json")
    .withRecipe(async function () {
        await fs.promises.writeFile(firstAndOnlyOutput(this.outputs), JSON.stringify({
            version: require('./package.json').version,
            NODE_ENV: process.env.NODE_ENV || 'development'
        }))
        return { success: true }
    });

//
// gitFileSet idea
// to prevent looking again and again, define fileset that is descendant from actually committed
// files, so Yake will read all files from git and only filder them by selection and paths
// also, when "git" their status will be derived from git HEAD hash, if repository is clean, so
// caching can occur without calculating separate sha sums of each file
//
// export const tsSources = gitFileSet("src/**/*.ts?x").exclude(/.spec.ts$/);

export const tsSources = makeFileSet("src/**/*.ts?x").exclude(/.spec.ts$/)
export const testSources = makeFileSet("test/**/*.ts?x", "src/**/*.spec.tsx?");

export const tscEsm = typescript(tsSources, { target: 'esm', 'outDir': 'dist/esm' }).inputs(tsSources);
export const tscCjs = typescript(tsSources, { target: 'commonjs', 'outDir': "dist/cjs" }).inputs(tsSources);

export const testUnit = mocha(testSources)
    .requires(tsSources)
    .requires(outConfigJson);

export const testPrettier = prettier({ mode: 'check' }).inputs(tsSources, testSources);

yarnLock.affects(tscEsm, tscCjs);
packageJson.affects(outConfigJson);

// subproject

const foo = subProject("./3rdparty/foo/Yakefile");
export default { tscEsm, tscCjs, testPrettier, testUnit, foo };
