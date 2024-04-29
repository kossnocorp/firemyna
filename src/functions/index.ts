import chokidar from "chokidar";
import { build, BuildIncremental, BuildResult, OutputFile } from "esbuild";
import { readdir, readFile, stat } from "fs/promises";
import { sweep } from "js-fns";
import {
  basename,
  extname,
  normalize,
  parse as parsePath,
  relative,
  resolve,
} from "path";
import { FiremynaBuildConfig } from "../build";
import { resolvePlugin } from "../esbuild/resolve";

/**
 * Firebase Function defenition.
 */
export interface FiremynaFunction {
  /** The path relative to the workspace root */
  path: string;
  /** The function name */
  name: string;
}

export type FiremynaFunctionsBuild = Record<string, BuildResult>;

/**
 * Builds Firebase functions.
 * @param buildConfig - the Firemyna build config
 * @returns promise to the build result
 */
export async function buildFunctions(
  buildConfig: FiremynaBuildConfig
): Promise<FiremynaFunctionsBuild> {
  const fns = await listFunctions(buildConfig);
  const indexContents = stringifyFunctionsIndex(fns, buildConfig);
  const build: FiremynaFunctionsBuild = {};

  await Promise.all(
    fns
      .map(async (fn) => {
        const file = `${fn.name}.cjs`;
        const resolvePath = parsePath(
          relative(buildConfig.cwd, resolve(buildConfig.cwd, fn.path))
        ).dir;
        build[file] = await buildFile({
          file,
          input: {
            type: "contents",
            contents: await readFile(resolve(buildConfig.cwd, fn.path), "utf8"),
            sourceFile: basename(fn.path),
          },
          resolvePath,
          bundle: true,
          buildConfig,
        });
      })
      .concat([
        buildFile({
          file: "index.cjs",
          input: {
            type: "contents",
            contents: indexContents,
          },
          resolvePath: buildConfig.paths.functions.src,
          buildConfig,
        }).then((result) => {
          build["index.cjs"] = result;
        }),

        buildConfig.config.functionsInitPath &&
          readFile(buildConfig.config.functionsInitPath, "utf8").then(
            (contents) =>
              buildFile({
                file: "init.cjs",
                input: {
                  type: "contents",
                  contents,
                },
                resolvePath: parsePath(buildConfig.config.functionsInitPath!)
                  .dir,
                buildConfig: buildConfig,
              }).then((result) => {
                build["init.cjs"] = result;
              })
          ),
      ] as Promise<void>[])
  );

  return build;
}

/**
 * Generates functions index file string.
 *
 * @param list - the functions list
 * @param buildConfig - the Firemyna build config
 * @returns stringified index file
 */
export function stringifyFunctionsIndex(
  list: FiremynaFunction[],
  buildConfig: FiremynaBuildConfig
) {
  return (buildConfig.config.functionsInitPath ? [`import "./init.cjs";`] : [])
    .concat(
      list.map(
        (fn) => `export { default as ${fn.name} } from "./${fn.name}.cjs";`
      )
    )
    .concat(
      buildConfig.renderer
        ? [`export { default as renderer } from "./renderer";`]
        : []
    )
    .join("\n");
}

/**
 * The index file regexp.
 */
const indexRegExp = /^index\.[tj]sx?$/;

/**
 * The function name regexp
 */
const fnRegExp = /^.+\.[tj]sx?$/;

/**
 * Lists all functions in the functions directory.
 *
 * @param - the Firemyna config
 * @returns the list of functions
 */
export async function listFunctions(
  buildConfig: FiremynaBuildConfig
): Promise<FiremynaFunction[]> {
  const dir = await readdir(
    resolve(buildConfig.cwd, buildConfig.paths.functions.src)
  );

  return sweep(
    await Promise.all<FiremynaFunction | undefined>(
      dir.map(async (itemPath) => {
        const fullPath = resolve(
          buildConfig.cwd,
          buildConfig.paths.functions.src,
          itemPath
        );
        const path = await findFunctionPath(buildConfig.cwd, fullPath);
        if (!path) return;

        const { name } = parsePath(itemPath);
        const fn = { name, path };

        if (includedFunction(buildConfig, fn)) return fn;
      })
    )
  );
}

export type FiremynaWatchCallback = (message: FiremynaWatchMessage) => void;

export type FiremynaWatchMessage =
  | FiremynaWatchMessageInitial
  | FiremynaWatchMessageFunction
  | FiremynaWatchMessageInit;

export interface FiremynaWatchMessageInitial {
  type: "initial";
  functions: FiremynaFunction[];
}

export interface FiremynaWatchMessageFunction {
  type: "function";
  event: "add" | "unlink" | "change";
  function: FiremynaFunction;
}

export interface FiremynaWatchMessageInit {
  type: "init";
  event: "add" | "unlink" | "change";
}

export async function watchListFunction(
  buildConfig: FiremynaBuildConfig,
  callback: FiremynaWatchCallback
) {
  const functions = await listFunctions(buildConfig);
  callback({ type: "initial", functions });

  const watcher = chokidar.watch(
    [buildConfig.paths.functions.src].concat(
      buildConfig.config.functionsInitPath || []
    ),
    {
      persistent: true,
      depth: 1,
      ignoreInitial: true,
    }
  );

  watcher.on("all", (event, path) => {
    switch (event) {
      case "add":
      case "change":
      case "unlink":
        if (isInitPath(buildConfig.config.functionsInitPath, path)) {
          callback({ type: "init", event });
        } else {
          const fn = parseFunction(buildConfig, path);
          if (!fn || !includedFunction(buildConfig, fn)) return;
          callback({ type: "function", event, function: fn });
        }
    }
  });
}

/**
 * Checks if the specified path is a function and if true, returns its
 * definition object.
 *
 * @param buildConfig - the Firemyna build config
 * @param functionPath - the path to function to find function in
 * @returns the function object
 */
export function parseFunction(
  buildConfig: FiremynaBuildConfig,
  functionPath: string
): FiremynaFunction | undefined {
  const path = relative(process.cwd(), functionPath);
  const relativePath = relative(
    resolve(buildConfig.cwd, buildConfig.paths.functions.src),
    functionPath
  );
  const parsedPath = parsePath(relativePath);

  if (parsedPath.dir) {
    const nested = !!parsePath(parsedPath.dir).dir;
    if (!nested && indexRegExp.test(parsedPath.base)) {
      const name = parsedPath.dir;
      return { name, path };
    }
  } else if (fnRegExp.test(parsedPath.base)) {
    const name = parsedPath.name;
    return { name, path };
  }
}

/**
 * Tests if the function is not ignored and if only list if present that it's
 * in it
 *
 * @param config - the Firemyna config
 * @param fn - the function to test
 * @returns true if the function is included in build
 */
export function includedFunction(
  {
    config: { functionsIgnorePaths, onlyFunctions, functionsInitPath },
  }: FiremynaBuildConfig,
  fn: FiremynaFunction
): boolean {
  return (
    !isInitPath(functionsInitPath, fn.path) &&
    !functionsIgnorePaths?.find((regex) => regex.test(fn.path)) &&
    (!onlyFunctions || onlyFunctions.includes(fn.name))
  );
}

/**
 * Checks if the passed path is the init path.
 * @param functionsInitPath - the path to the init file
 * @param path - the path to test
 * @returns true if the path is the init path
 */
function isInitPath(functionsInitPath: string | undefined, path: string) {
  return functionsInitPath && normalize(path) === normalize(functionsInitPath);
}

/**
 * Finds the function path, tests if the function is a TS/JS file or a directory
 * with TS/JS index file.
 *
 * @param cwd - the working directory
 * @param path - the full path to the possible function file or dir
 * @returns the relative path to the function file if found, otherwise undefined
 * @private
 */
async function findFunctionPath(
  cwd: string,
  path: string
): Promise<string | undefined> {
  const stats = await stat(path);

  if (stats.isDirectory()) {
    const files = await readdir(path);
    const indexFile = files.find((file) => indexRegExp.test(file));
    if (!indexFile) return;
    return relative(cwd, resolve(path, indexFile));
  } else if (fnRegExp.test(path)) {
    return relative(cwd, path);
  }
}

export interface BuildFileProps<Incremental extends boolean | undefined> {
  file: string;
  input: BuildFileInput;
  resolvePath: string;
  bundle?: boolean;
  buildConfig: FiremynaBuildConfig;
  incremental?: Incremental;
  metafile?: boolean;
}

export type BuildFileInput = BuildFileInputEntry | BuildFileInputContents;

export interface BuildFileInputEntry {
  type: "entry";
  path: string;
  sourceFile?: string;
}

export interface BuildFileInputContents {
  type: "contents";
  contents: string;
  sourceFile?: string;
}

export function buildFile<Incremental extends boolean | undefined>(
  props: BuildFileProps<Incremental>
): Incremental extends true
  ? Promise<BuildIncremental & { outputFiles: OutputFile[] }>
  : Promise<BuildResult & { outputFiles: OutputFile[] }>;

export function buildFile<Incremental extends boolean | undefined>({
  file,
  input,
  resolvePath,
  bundle,
  buildConfig,
  incremental,
}: BuildFileProps<Incremental>) {
  return build({
    bundle,
    platform: "node",
    target: `node${buildConfig.config.node}`,
    sourcemap: "external",
    format: "cjs",
    outfile: getBuildFunctionsFilePath(buildConfig, file),
    entryPoints: input.type === "entry" ? [input.path] : undefined,
    stdin:
      input.type === "contents"
        ? {
            loader: sourceFileLoader(input.sourceFile || file),
            contents: input.contents,
            sourcefile: input.sourceFile || file,
            resolveDir: resolvePath,
          }
        : undefined,

    plugins: [resolvePlugin()],
    allowOverwrite: true,
    write: false,
    incremental,
    metafile: true,
  });
}

export function getBuildFunctionsFilePath(
  buildConfig: FiremynaBuildConfig,
  file: string
) {
  return resolve(buildConfig.cwd, buildConfig.paths.functions.build, file);
}

function sourceFileLoader(sourceFile: string) {
  const ext = extname(sourceFile);
  if (ext === ".ts") return "ts";
  if (ext === ".tsx") return "tsx";
  if (ext === ".jsx") return "jsx";
  return "js";
}
