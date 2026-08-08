import Link from "next/link";
import { headers } from "next/headers";
import AssetQrScanner from "./asset-qr-scanner";

export default async function AssetQrScannerPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/assets">← Assets</Link>
          <div className="title">Scan asset QR</div>
          <div className="muted">Open an equipment record directly from its printed OpenGMAO label.</div>
        </div>
      </div>

      {!organizationId || !siteId ? (
        <section className="card">
          <h2>Site context required</h2>
          <p className="muted">Select an organization and site before scanning an asset label.</p>
        </section>
      ) : (
        <AssetQrScanner organizationId={organizationId} siteId={siteId} />
      )}
    </>
  );
}
