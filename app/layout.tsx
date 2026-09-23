import React from "react";

export const metadata = {
  title: "Long2Short",
  description: "Turn long-form YouTube videos into short-form 9:16 clips using AI editing + Remotion rendering.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0B0C0E", color: "#E8E6E1", fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}