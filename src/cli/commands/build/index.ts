import { CliUx, Command } from "@oclif/core";
import cp from "child_process";
import { difference, remove } from "js-fns";
import { resolve } from "path";
import { promisify } from "util";
import { getBuildConfig } from "../../../build";
import { prepareBuild } from "../../../build/prepare";
import { configWithDefaults, loadConfig } from "../../../config";
import { listPkgDependencies, parseBuildDependencies } from "../../../deps";
import { writeEsbuildFile } from "../../../esbuild";
import { buildFile, buildFunctions } from "../../../functions";
import { presetProjectPaths } from "../../../presets/paths";
import { nextRenderer, remixRenderer } from "../../../presets/renderer";
import { configFlag, cwdFlag, projectFlag } from "../../flags";

const exec = promisify(cp.exec);

export default class Build extends Command {
  static description = "Build the Firemyna project";

  static flags = {
    cwd: cwdFlag,
    config: configFlag,
    project: projectFlag,
  };

  async run() {
    const { flags } = await this.parse(Build);
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
      mode: "build",
      project,
      appEnv: "production",
      cwd,
      config: resolvedConfig,
      projectPaths,
      renderer: config.preset === "remix" || config.preset === "next",
    });

    CliUx.ux.action.start("Building the app");

    const [_functions, { pkg }, _rendererResult] = await Promise.all([
      buildFunctions(buildConfig).then(async (functions) => {
        await Promise.all(Object.values(functions).map(writeEsbuildFile));
        return functions;
      }),

      prepareBuild(buildConfig),

      config.preset === "remix"
        ? await exec("npx remix build", {
            cwd: buildConfig.cwd,
            env: { ...process.env, NODE_ENV: "production" },
          }).then(async () => {
            const build = await buildFile({
              file: "renderer.js",
              input: {
                type: "contents",
                contents: remixRenderer(),
              },
              resolvePath: resolve(
                buildConfig.cwd,
                buildConfig.paths.functions.build
              ),
              buildConfig,
            });

            await writeEsbuildFile(build);

            await exec(
              `rsync --recursive --prune-empty-dirs --exclude=build/* public/* ${buildConfig.paths.hosting.build}`,
              { cwd: resolve(buildConfig.cwd) }
            );

            return build;
          })
        : config.preset === "next"
        ? await exec("npx next build", {
            cwd: buildConfig.cwd,
            env: { ...process.env, NODE_ENV: "production" },
          }).then(async () => {
            const build = await buildFile({
              file: "renderer.js",
              input: {
                type: "contents",
                contents: nextRenderer(),
              },
              resolvePath: resolve(
                buildConfig.cwd,
                buildConfig.paths.functions.build
              ),
              buildConfig,
            });

            await writeEsbuildFile(build);

            await exec(
              `rsync --recursive --prune-empty-dirs public/* ${buildConfig.paths.hosting.build}`,
              { cwd: resolve(buildConfig.cwd) }
            );

            await exec(
              `rsync --recursive .next ${buildConfig.paths.functions.build}`,
              { cwd: resolve(buildConfig.cwd) }
            );

            return build;
          })
        : undefined,
    ]);

    CliUx.ux.action.stop();

    if (config.optimizePackages) {
      // TODO: Add support for:
      // - yarn, pnpm
      // - npm without package-lock.json
      // - workspaces?
      CliUx.ux.action.start("Optimizing npm dependencies");

      const buildDeps = await parseBuildDependencies(buildConfig);
      const pkgDeps = listPkgDependencies(pkg);
      const unusedDeps = remove(
        difference(pkgDeps, buildDeps),
        "firebase-admin"
      );

      await exec(`npm uninstall --package-lock-only ${unusedDeps.join(" ")}`, {
        cwd: resolve(buildConfig.cwd, buildConfig.paths.appEnvBuild),
      });

      CliUx.ux.action.stop();
    }

    let p: cp.ChildProcess | undefined;

    switch (config.preset) {
      case "astro": {
        p = cp.spawn("npx", ["astro", "build"], {
          cwd: buildConfig.cwd,
          shell: true,
          stdio: "inherit",
        });
        break;
      }

      case "cra": {
        p = cp.spawn("npx", ["react-scripts", "build"], {
          cwd: buildConfig.cwd,
          shell: true,
          stdio: "inherit",
          env: {
            ...process.env,
            BUILD_PATH: buildConfig.paths.hosting.build,
          },
        });
        break;
      }

      case "vite": {
        p = cp.spawn("npx", ["vite", "build"], {
          cwd: buildConfig.cwd,
          shell: true,
          stdio: "inherit",
        });
        break;
      }
    }

    await new Promise((resolve) =>
      p ? p.on("close", resolve) : resolve(void 0)
    );

    return buildConfig;
  }
}
