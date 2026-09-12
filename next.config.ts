import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The dev overlay badge is off because the demo is RECORDED FROM THE DEV
   * SERVER.
   *
   * `npm run qa:capture` and the demo video both drive `next dev` — the SSE
   * route needs a plain Node server and the workbench is process-long, so
   * there is no production deployment to record instead. The badge sits in the
   * bottom-left corner, which is where the co-sign split screen prints the
   * sentence carrying its whole argument, and it was overlapping that text in
   * the captured frame.
   *
   * This turns off an indicator, not a check: build errors still surface in the
   * terminal and in the browser's error overlay.
   */
  devIndicators: false,
};

export default nextConfig;
