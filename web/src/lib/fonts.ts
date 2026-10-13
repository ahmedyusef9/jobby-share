import { DM_Sans, Heebo, Readex_Pro, Bellefair, Noto_Naskh_Arabic } from "next/font/google";

// English UI / body — DM Sans (self-hosted via next/font).
export const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

// Hebrew UI / body.
export const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  variable: "--font-heebo",
  display: "swap",
});

// Arabic UI / body.
export const readexPro = Readex_Pro({
  subsets: ["arabic", "latin"],
  variable: "--font-readex-pro",
  display: "swap",
});

// Editorial / Hebrew headlines.
export const bellefair = Bellefair({
  subsets: ["hebrew", "latin"],
  weight: "400",
  variable: "--font-bellefair",
  display: "swap",
});

// Arabic headlines / editorial.
export const notoNaskh = Noto_Naskh_Arabic({
  subsets: ["arabic"],
  variable: "--font-noto-naskh",
  display: "swap",
});

/** Display / editorial className — prefer `font-display` utility when possible. */
export const displayFont = bellefair;

/** @deprecated Use displayFont or font-display — kept for gradual migration. */
export const instrumentSerif = bellefair;
