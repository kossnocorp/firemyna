import { CachedInputFileSystem, ResolverFactory } from "enhanced-resolve";
import { Plugin } from "esbuild";
import * as fs from "fs";
import { builtinModules } from "module";

export function resolvePlugin(): Plugin {
  const resolver = ResolverFactory.createResolver({
    // @ts-ignore: fs is fine,
    fileSystem: new CachedInputFileSystem(fs, 4000),
    extensions: [".js", ".ts", ".jsx", ".tsx"],
    conditionNames: ["default", "node", "require"],
  });

  return {
    name: "node-resolve",
    setup: ({ onResolve }) => {
      onResolve({ filter: /.*/ }, ({ resolveDir, path }) => {
        return new Promise((resolve, reject) => {
          const context = {};
          const resolveContext = {};

          if (builtinModules.some((module) => path.startsWith(module))) {
            resolve({ path, external: true });
            return;
          }

          resolver.resolve(
            context,
            resolveDir,
            path,
            resolveContext,
            (err, resolved) => {
              console.log({ resolveDir, path, resolved });
              if (err || !resolved)
                return reject(
                  err || new Error(`Cannot resolve ${path} at ${resolveDir}`)
                );
              resolve({
                path: resolved,
                external: resolved.includes("node_modules"),
              });
            }
          );
        });
      });
    },
  };
}
