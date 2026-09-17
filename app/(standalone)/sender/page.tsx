import { SenderForm } from "@/components/sender/sender-form";
import { SenderShipments } from "@/components/sender/sender-shipments";
import { SenderShell } from "@/components/shells/sender-shell";
import { ADDRESSES } from "@/lib/generate/world";
import { getWorkbench } from "@/lib/workbench";

export const dynamic = "force-dynamic";

export default async function SenderPage() {
  const workbench = await getWorkbench();

  // The address list is resolved on the server. Importing the generator into a
  // client component would pull the whole synthetic-data tree into the browser
  // bundle for what is, on this page, twenty-four labels.
  const addresses = ADDRESSES.map((address, index) => ({ index, label: address.label, latitude: address.latitude, longitude: address.longitude }));

  return (
    <SenderShell identity={workbench.identities().sender} addressCount={addresses.length}>
      <SenderForm addresses={addresses} policy={workbench.senderPolicy()} />
      <SenderShipments
        shipments={workbench.listSenderShipments().filter((s) => !s.delivered)}
        addresses={addresses}
      />
    </SenderShell>
  );
}
