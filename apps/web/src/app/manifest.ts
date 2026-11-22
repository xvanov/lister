import type { MetadataRoute } from "next";

/**
 * Web app manifest (served at /manifest.webmanifest): lets the app be installed
 * to a phone's home screen and open full-screen at /app. Rename alongside the
 * <title> in layout.tsx, icon.svg and apple-icon.png (iOS home screen,
 * served by Next as <link rel="apple-touch-icon">); colours match --background in globals.css.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lister",
    short_name: "Lister",
    description: "Lister",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
