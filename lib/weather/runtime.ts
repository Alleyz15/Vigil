import { join } from "node:path";
import { createOpenMeteoProvider } from "./open-meteo";

export const OPEN_METEO_CACHE_DIR = join(process.cwd(), "data", "weather", "open-meteo");

let singleton: ReturnType<typeof createOpenMeteoProvider> | undefined;

/** Process-wide adapter used by the local Node console. */
export function openMeteoProvider() {
  singleton ??= createOpenMeteoProvider({ cacheDir: OPEN_METEO_CACHE_DIR });
  return singleton;
}

