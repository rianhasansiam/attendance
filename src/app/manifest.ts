import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "XHYD Attendance System",
    short_name: "Attend",
    description: "Secure attendance for your workday.",
    start_url: "/employee/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#f6f7f4",
    theme_color: "#17664d",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
