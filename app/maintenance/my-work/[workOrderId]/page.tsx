import Link from "next/link";
import { headers } from "next/headers";
import TechnicianWorkOrder from "./technician-work-order";

export default async function TechnicianWorkOrderPage({
  params,
}: {
  params: Promise<{ workOrderId: string }>;
}) {
  const { workOrderId } = await params;
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/maintenance/my-work">← My work</Link>
          <h1 className="title">Technician work order</h1>
          <div className="muted">Focused execution mode for the shop floor.</div>
        </div>
      </div>

      {!organizationId || !siteId ? (
        <section className="card">
          <p>Select an organization and site to open technician mode.</p>
        </section>
      ) : (
        <TechnicianWorkOrder
          organizationId={organizationId}
          siteId={siteId}
          workOrderId={workOrderId}
        />
      )}
    </>
  );
}
