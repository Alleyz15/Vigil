import { LandingView } from "@/components/landing/landing-view";

export const metadata = {
  title: "Vigil — agentic handoff trust verifier",
  description:
    "A handoff is a claim, not a fact. Vigil cross-checks signals against each other, keeps single-event and pattern risk on separate axes, and makes operator approval cryptographically constitutive.",
};

export default function Home() {
  return <LandingView />;
}
