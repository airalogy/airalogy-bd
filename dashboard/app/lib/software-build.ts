import packagedBuild from "./build-info.json";

// Source development keeps generated identity out of tracked files. Next.js
// embeds this public metadata consistently in the server and browser bundles.
const buildInfo: typeof packagedBuild = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_BD_DEV_BUILD_INFO
  ? JSON.parse(process.env.NEXT_PUBLIC_BD_DEV_BUILD_INFO)
  : packagedBuild;

export default buildInfo;
