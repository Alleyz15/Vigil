import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AppShell } from "@/components/operator/app-shell";
import { getWorkbench } from "@/lib/workbench";
import "leaflet/dist/leaflet.css";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Vigil operator workbench",
  description: "Process handoffs that need verification, co-signature, or escalation.",
};

/**
 * The shell reads the operator's real key, so it reads process-long mutable
 * state and cannot be prerendered. Every content route already declares this;
 * saying it here makes the shell's own dependency honest rather than relying on
 * each page to carry it.
 */
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The identity comes from the server because a fingerprint is only worth
  // showing if it is a truncation of the key a credential is actually checked
  // against. A hardcoded string in the client bundle would look identical and
  // mean nothing.
  const workbench = await getWorkbench();

  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="antialiased">
        <AppShell identity={workbench.identities().operator}>{children}</AppShell>
      </body>
    </html>
  );
}
