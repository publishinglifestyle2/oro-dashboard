import type { NextConfig } from "next";
import path from "path";

// evita che turbopack risalga fino alla home directory cercando un monorepo:
// nella home c'è un package.json di un altro progetto, non legato a questo.
const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
