import type { Metafile } from "esbuild";
import chokidar from "chokidar";

export function extractWatchFiles(meta: Metafile) {
  const files = new Set<string>();

  Object.values(meta.outputs).forEach((output) => {
    output.imports.forEach((imp) => {
      files.add(imp.path);
    });

    Object.keys(output.inputs).forEach((input) => {
      files.add(input);
    });
  });

  return files;
}

export function startWatchingFiles(prev: Set<string>, next: Set<string>) {
  const files = new Set<string>();

  next.forEach((file) => {
    if (!prev.has(file)) files.add(file);
  });

  return files;
}

export function stopWatchingFiles(prev: Set<string>, next: Set<string>) {
  const files = new Set<string>();

  prev.forEach((file) => {
    if (!next.has(file)) files.add(file);
  });

  return files;
}

export interface WatchDepToEntries {
  [dep: string]: Set<string>;
}

export interface WatchEntryToDeps {
  [file: string]: Set<string>;
}

export function watchDeps(onRebuild: (entry: string) => void) {
  const depsToEntries: WatchDepToEntries = {};
  const entriesToDeps: WatchEntryToDeps = {};

  const watch = chokidar.watch([]);

  const debounceTimers: DebounceTimers = {};

  watch.on("all", (event, path) => {
    switch (event) {
      case "change":
      case "unlink":
        depsToEntries[path]?.forEach((entry) => {
          // @ts-ignore: WTF TypeScript?
          clearTimeout(debounceTimers[entry]);

          debounceTimers[entry] = setTimeout(() => {
            onRebuild(entry);
            delete debounceTimers[path];
          }, 100);
        });
    }
  });

  function stopWatching(entry: string, dep: string) {
    const entries = depsToEntries[dep] || new Set<string>();
    entries.delete(entry);
    depsToEntries[dep] = entries;
    if (entries.size === 0) watch.unwatch(dep);
  }

  function onBuild(entry: string, metafile: Metafile) {
    const prev = entriesToDeps[entry] || new Set<string>();
    const next = extractWatchFiles(metafile);

    const start = startWatchingFiles(prev, next);
    const stop = stopWatchingFiles(prev, next);

    start.forEach((dep) => {
      const entries = depsToEntries[dep] || new Set<string>();
      entries.add(entry);
      depsToEntries[dep] = entries;
      watch.add(dep);
    });

    stop.forEach((dep) => stopWatching(entry, dep));

    entriesToDeps[entry] = next;
  }

  function onStop(entry: string) {
    const deps = entriesToDeps[entry] || new Set<string>();
    deps.forEach((dep) => stopWatching(entry, dep));
    delete entriesToDeps[entry];
  }

  return { onBuild, onStop };
}

interface DebounceTimers {
  [entry: string]: NodeJS.Timeout;
}
