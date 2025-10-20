import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, './'),
  },
  output: 'export',
};

export default nextConfig;
