import { Command } from "@oclif/core";
import cp from "child_process";
import { BuildIncremental, Metafile, analyzeMetafile } from "esbuild";
import { basename, join, parse as parsePath, relative, resolve } from "path";
import { FiremynaBuildConfig, getBuildConfig } from "../../../build";
import { prepareBuild } from "../../../build/prepare";
import { loadConfig, configWithDefaults } from "../../../config";
import { writeEsbuildFile } from "../../../esbuild";
import {
  buildFile,
  FiremynaFunction,
  stringifyFunctionsIndex,
  watchListFunction,
} from "../../../functions";
import { presetProjectPaths } from "../../../presets/paths";
import { configFlag, cwdFlag, projectFlag } from "../../flags";
import pc from "picocolors";
import { Formatter } from "picocolors/types";
import { difference } from "js-fns";
import { watchDeps } from "../../../watch";

export default class Dev extends Command {
  static description = "Starts the Firemyna development server";

  static flags = {
    cwd: cwdFlag,
    config: configFlag,
    project: projectFlag,
  };

  async run() {
    const { flags } = await this.parse(Dev);
    const { project } = flags;
    const cwd = resolve(flags.cwd);

    const config = await loadConfig(cwd, flags.config);
    if (!config) throw new Error("Can not find the Firemyna config file");
    const resolvedConfig = configWithDefaults(config);

    const projectPaths = presetProjectPaths(
      config.preset,
      config.functionsPath
    );
    const buildConfig = getBuildConfig({
      mode: "dev",
      project,
      appEnv: "development",
      cwd,
      config: resolvedConfig,
      projectPaths,
      renderer: false,
    });

    await prepareBuild(buildConfig);

    const builds: Record<string, BuildIncremental> = {};
    let initBuild: BuildIncremental | undefined = undefined;
    let functions: FiremynaFunction[] = [];

    const { onBuild, onStop } = watchDeps(async (file) => {
      log({
        label: "Firemyna",
        formatter: pc.magenta,
        message: `Rebuilding ${pc.blue(file)}...`,
      });
      const build = await builds[file]?.rebuild();
      build?.metafile && onBuild(file, build.metafile);
      return writeEsbuildFile(build);
    });

    async function startBuilding(fn: FiremynaFunction) {
      const build = await incrementalBuild(buildConfig, fn);
      build?.metafile && onBuild(fn.name, build.metafile);
      builds[fn.name] = build;
      await writeEsbuildFile(build);
    }

    async function startBuildingInit() {
      if (!buildConfig.config.functionsInitPath) return;

      initBuild = await incrementalBuildInit(buildConfig);

      initBuild?.metafile && onBuild("init.cjs", initBuild.metafile);

      initBuild && (await writeEsbuildFile(initBuild));
    }

    async function buildIndex() {
      const indexContents = stringifyFunctionsIndex(functions, buildConfig);
      const build = await buildFile({
        file: "index.cjs",
        input: {
          type: "contents",
          contents: indexContents,
        },
        resolvePath: buildConfig.paths.functions.src,
        buildConfig,
      });

      build?.metafile && onBuild("index.cjs", build.metafile);

      return writeEsbuildFile(build);
    }

    const children: cp.ChildProcessWithoutNullStreams[] = [];

    const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

    signals.forEach((signal) => {
      process.on(signal, () => {
        console.log(`Received ${signal}, notifying children...`);

        children.forEach((child) => {
          child.on("exit", (code, signal) => {
            children.splice(children.indexOf(child), 1);

            if (!children.length) {
              console.log("All children exited, exiting main process...");
              process.exit(0);
            }
          });
        });

        children.forEach((child) => child.kill("SIGINT"));
      });
    });

    watchListFunction(buildConfig, async (message) => {
      switch (message.type) {
        case "initial": {
          functions = message.functions;

          await Promise.all([
            startBuildingInit(),
            Promise.all(message.functions.map(startBuilding)),
            buildIndex(),
          ]);

          const cwdRelativeToBuildDir = relative(
            buildConfig.paths.appEnvBuild,
            cwd
          );
          const emulatorsPath = join(
            cwdRelativeToBuildDir,
            typeof config.emulators?.persistence === "string"
              ? config.emulators.persistence
              : ".firebase/emulators"
          );

          const firebaseChild = cp.spawn(
            "npx",
            (buildConfig.config.emulators
              ? ["firebase", "emulators:start"].concat(
                  config.emulators?.persistence !== false
                    ? [`--import=${emulatorsPath}`, "--export-on-exit"]
                    : []
                )
              : ["firebase", "serve", "--only", "functions"].concat(
                  config.hosting ? ["--only", "hosting"] : []
                )
            ).concat(project ? ["--project", project] : []),
            {
              cwd: resolve(buildConfig.cwd, buildConfig.paths.appEnvBuild),
              shell: true,
            }
          );

          children.push(firebaseChild);

          watchChildLog({
            child: firebaseChild,
            formatter: pc.yellow,
            label: "Firebase",
          });

          return;
        }

        case "init": {
          switch (message.event) {
            case "add": {
              await startBuildingInit();
              return initBuild && buildIndex();
            }

            case "change": {
              const build = await initBuild?.rebuild();
              return initBuild && writeEsbuildFile(build);
            }

            case "unlink": {
              log({
                label: "Firebase",
                formatter: pc.red,
                message: `The init function was removed. Please restart the server if the configuration has changed.`,
              });
              initBuild = undefined;
              onStop("init.cjs");
              return;
            }
          }
        }

        case "function": {
          switch (message.event) {
            case "add": {
              functions.push(message.function);
              await startBuilding(message.function);
              return buildIndex();
            }

            case "change": {
              const build = await builds[message.function.name]?.rebuild();
              return writeEsbuildFile(build);
            }

            case "unlink": {
              functions = functions.filter(
                (fn) => fn.name !== message.function.name
              );
              builds[message.function.name]?.rebuild.dispose();
              delete builds[message.function.name];
              buildIndex();
              // Stop watching the file
              onStop(message.function.name);
              break;
            }
          }
        }
      }
    });

    switch (config.preset) {
      case "astro": {
        const astroChild = cp.spawn("npx", ["astro", "dev"], {
          cwd: buildConfig.cwd,
          shell: true,
        });

        children.push(astroChild);

        watchChildLog({
          child: astroChild,
          formatter: pc.green,
          label: "Astro",
        });

        break;
      }

      case "cra": {
        const craChild = cp.spawn("npx", ["react-scripts", "start"], {
          cwd: buildConfig.cwd,
          shell: true,
        });

        children.push(craChild);

        watchChildLog({
          child: craChild,
          formatter: pc.green,
          label: "CRA",
        });

        break;
      }

      case "vite": {
        const viteChild = cp.spawn("npx", ["vite"], {
          cwd: buildConfig.cwd,
          shell: true,
        });

        children.push(viteChild);

        watchChildLog({
          child: viteChild,
          formatter: pc.green,
          label: "Vite",
        });

        break;
      }

      case "remix": {
        const remixChild = cp.spawn("npx", ["remix", "dev"], {
          cwd: buildConfig.cwd,
          shell: true,
          env: { ...process.env, NODE_ENV: "development" },
        });

        children.push(remixChild);

        watchChildLog({
          child: remixChild,
          formatter: pc.green,
          label: "Remix",
        });

        break;
      }

      case "next": {
        const nextChild = cp.spawn("npx", ["next", "dev"], {
          cwd: buildConfig.cwd,
          shell: true,
          env: { ...process.env, NODE_ENV: "development" },
        });

        children.push(nextChild);

        watchChildLog({
          child: nextChild,
          formatter: pc.green,
          label: "Next.js",
        });

        break;
      }
    }
  }
}

interface LogChildProps {
  label: string;
  child: cp.ChildProcessWithoutNullStreams;
  formatter: Formatter;
}

function watchChildLog({ label, child, formatter }: LogChildProps) {
  child.stdout.on("data", (data) => {
    log({ label, formatter, message: data.toString().trim() });
  });

  child.stderr.on("data", (data) => {
    log({ label, formatter, message: data.toString().trim(), error: true });
  });
}

interface LogProps {
  label: string;
  formatter: Formatter;
  message: string;
  error?: boolean;
}

function log({ label, formatter, message, error }: LogProps) {
  const paddedLabel = label.padStart(8, " ");
  const formattedLabel = paddedLabel + " | ";

  if (error) console.log(pc.red(formattedLabel) + message);
  else console.log(pc.dim(formatter(formattedLabel)) + message);
}

async function incrementalBuild(
  buildConfig: FiremynaBuildConfig,
  fn: FiremynaFunction
) {
  const file = `${fn.name}.cjs`;
  return buildFile({
    file,
    input: {
      type: "entry",
      path: resolve(buildConfig.cwd, fn.path),
      sourceFile: basename(fn.path),
    },
    resolvePath: resolve(buildConfig.cwd, parsePath(fn.path).dir),
    bundle: true,
    buildConfig,
    incremental: true,
    metafile: true,
  });
}

async function incrementalBuildInit(buildConfig: FiremynaBuildConfig) {
  const initPath = buildConfig.config.functionsInitPath;
  if (!initPath) return;
  return buildFile({
    file: "init.cjs",
    input: {
      type: "entry",
      path: resolve(buildConfig.cwd, initPath),
      sourceFile: basename(initPath),
    },
    resolvePath: resolve(buildConfig.cwd, parsePath(initPath).dir),
    bundle: true,
    buildConfig,
    incremental: true,
    metafile: true,
  });
}

interface ExternalWatch {
  [pkg: string]: {
    [file: string]: boolean;
  };
}

interface ExternalPackages {
  [file: string]: string[];
}
