# signals-v1 simulation assumptions

Every number in `assumptions.ts` is explicitly an **ASSUMPTION**. These are
exploration distributions, not calibrated fleet prevalence or detection targets.
Change them only when the modeled claim about behavior is wrong, and version the
generator. Never select them in response to an alert rate or detector cut point.

The source comments document every probability and band. Uniform draws are used
unless marked log-uniform. Independent named streams separate behavior, GPS,
device clocks, upload latency, proof, identity, history timing and disputes.
Ordinary and degraded GPS uncertainty overlap across usable and unusable fixes;
actual position error is sampled separately from the reported confidence radius.
Environmental noise may cause real detector alerts in this synthetic world.

Device clock errors remain stable for the same seed/version/courier/device.
Changing the seed selects a different hypothetical device configuration error;
it does not model normal clock drift between shipments in a continuous journal.
Each shipment's persisted snapshot retains its original configuration. A seed
change is explicit simulated context, not evidence that a real device drifted.
Server-minted shipment UUIDs affect event/artifact identities only. They never
enter factual random streams; identical confirmed inputs and courier context
with the same seed/version reproduce the same physical facts and conditions.
Server receipts use true time plus upload latency. Photos use the handset clock.
OTP issuance, expiry and verifier receipt use independent server time. Device
enrollment and recipient-channel records stay outside EPCIS. Sampled anomalies
have named behavior causes; passed/failed/unevaluated integrity stays distinct.
An explicit handset override is resolved before deriving its clock and clock
provenance. Explicit integrity success/failure determines both the emitted
attestation and its condition; omitted overrides retain the sampled outcome.
Replacement claims do not enroll a handset. Only devices present in the supplied
world carry their existing owner's enrollment policy; unknown devices retain
any independent OTP reference while enrollment stays absent.

Normal history is a delivery round. Burst history is a building with genuinely
clustered recipient references. Clumped scans reuse one van position against the
unaltered distributed parcel references. Recurring signals repeatedly report a
mock-location provider during a building batch round (the same physical cadence
as burst, with an additional recurring handset signal). History contains parsed events and recipient disputes;
only the detector may derive scores or repeated-flag statistics from it.
Each profile is a behavior model, not a promise that any rule will fire.
The bootstrap is assumed to be one unplugged round. Its handset battery drains
from elapsed round time and cumulative physical scan-to-scan distance using the
same consumption assumptions as the current timeline; it does not restart for
each parcel. A clumped van uses its physical scan positions for this distance,
not the recipient addresses it claims to have served.

History takes available distinct parcels from the courier's world tail. Short
worlds remain short histories. A parent journal retains the first bootstrap and
extends it with actual sealed events; this pure builder does not maintain state.
Unknown online locations have no cell/WiFi IDs. Optional registered observations
must already exist in the supplied world. Working-hour authorization is never
invented: I13 uses the existing mandate or remains unavailable.
