import type { Metadata } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const inter = Inter({ variable: "--font-sans", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Vigil — handoff trust console",
  description: "Operator console for the Vigil handoff trust verifier.",
};

/**
 * The console shell.
 *
 * THREE ROUTES, NOT TABS. Deep links matter — /timeline?scenario=S2 goes
 * straight to the argument during a demo — and the stream view holds a live
 * EventSource that a tab switch would either tear down or leave running
 * invisibly. A route boundary makes that lifecycle obvious.
 *
 * Desktop operator console. Dense, not cramped.
 */
const NAV = [
  { href: "/timeline", label: "Shipment timeline", hint: "normal → exception" },
  { href: "/stream", label: "Reasoning stream", hint: "the eight nodes, live" },
  { href: "/gate", label: "Gate explorer", hint: "the two axes" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${mono.variable} antialiased bg-background text-foreground`}>
        <div className="flex min-h-screen">
          <aside className="w-60 shrink-0 border-r border-border/60 bg-card/30 px-4 py-5">
            <Link href="/" className="block">
              <div className="font-mono text-sm font-semibold tracking-tight">VIGIL</div>
              <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                handoff trust verifier
              </div>
            </Link>

            <nav className="mt-7 space-y-1">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="block rounded-md px-2.5 py-2 transition-colors hover:bg-accent/60"
                >
                  <div className="text-[13px] leading-tight">{item.label}</div>
                  <div className="text-[11px] leading-tight text-muted-foreground">{item.hint}</div>
                </Link>
              ))}
            </nav>

            <div className="mt-8 border-t border-border/60 pt-4 text-[11px] leading-relaxed text-muted-foreground">
              <div className="font-medium text-foreground/80">Two roles</div>
              <div>courier · operator</div>
              <div className="mt-3 font-medium text-foreground/80">Data</div>
              <div>synthetic, seeded</div>
              <div>
                <code className="text-[10px]">vigil-2026</code>
              </div>
            </div>
          </aside>

          <main className="min-w-0 flex-1">
            <div className="mx-auto max-w-[1600px] px-8 py-7">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
